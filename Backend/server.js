import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import { createClient } from '@supabase/supabase-js';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

// Middleware
app.use(cors({
    origin: process.env.CORS_ORIGIN || '*',
    methods: ['GET', 'POST', 'PUT', 'DELETE'],
    credentials: true,
}));
app.use(express.json());

// Supabase Admin Client (service role — keep this server-side only!)
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ═══════════════════════════════════════════════════════════════
//  IN-MEMORY LIVE DATA STORE  (fed by Python generator)
// ═══════════════════════════════════════════════════════════════

// Latest snapshot per building (keyed by building_id)
const liveBuildings = {};

// History ring-buffer per building – last 200 samples each
const buildingHistory = { B1: [], B2: [], B3: [], B4: [], B5: [] };
const MAX_HISTORY = 200;

// Building metadata (names, types)
const BUILDING_META = {
    B1: { name: 'Main Admin Block', btype: 'Residential' },
    B2: { name: 'Research Lab', btype: 'Residential Large' },
    B3: { name: 'Student Dorms', btype: 'Residential Small' },
    B4: { name: 'Cafeteria', btype: 'Commercial' },
    B5: { name: 'Guesthouse / EV Station', btype: 'Commercial Large' },
};

// Static fallback data (base values, used when generator hasn't sent data yet)
const FALLBACK_BUILDINGS_BASE = [
    { id: 'B1', name: 'Main Admin Block', baseSolar: 85, baseLoad: 85, baseBattery: 60 },
    { id: 'B2', name: 'Research Lab', baseSolar: 45, baseLoad: 120, baseBattery: 45 },
    { id: 'B3', name: 'Student Dorms', baseSolar: 80, baseLoad: 55, baseBattery: 85 },
    { id: 'B4', name: 'Cafeteria', baseSolar: 35, baseLoad: 50, baseBattery: 30 },
    { id: 'B5', name: 'Guesthouse / EV Station', baseSolar: 70, baseLoad: 40, baseBattery: 80 },
];

/**
 * Simulates time-varying building energy that causes buildings to
 * periodically enter deficit. Each building has a different oscillation
 * phase so they don't all flip at the same time.
 */
function getSimulatedBuildings() {
    const t = Date.now() / 1000; // seconds since epoch
    return FALLBACK_BUILDINGS_BASE.map((b, i) => {
        // Each building oscillates with different period and phase
        const phase = i * 1.3;  // offset each building
        const period = 40 + i * 8; // 40-72 second cycles
        const wave = Math.sin((t / period) + phase);
        const wave2 = Math.cos((t / (period * 0.7)) + phase * 0.5);

        // Solar varies: drops when wave is negative (simulates clouds)
        const solar = Math.max(10, Math.round(b.baseSolar + wave * 40 + (Math.random() - 0.5) * 10));
        // Load varies: spikes when wave2 is positive (simulates usage spikes)
        const load = Math.max(15, Math.round(b.baseLoad + wave2 * 30 + (Math.random() - 0.5) * 8));
        // Battery drains when in deficit
        const battery = Math.min(100, Math.max(5, Math.round(b.baseBattery + wave * 15 + (Math.random() - 0.5) * 5)));
        const status = solar < load ? 'Deficit' : 'Surplus';

        return {
            id: b.id,
            name: b.name,
            solar,
            load,
            battery,
            status,
            is_deficit: status === 'Deficit',
            solar_kw: solar,
            total_drained_kwh: load / 60,
            battery_kwh: (battery / 100) * 15,
            battery_cap: 15,
        };
    });
}

// Keep a static reference for compatibility (some endpoints still use this name)
const FALLBACK_BUILDINGS = FALLBACK_BUILDINGS_BASE.map(b => ({
    id: b.id, name: b.name,
    solar: b.baseSolar, load: b.baseLoad, battery: b.baseBattery,
    status: b.baseSolar >= b.baseLoad ? 'Surplus' : 'Deficit',
}));

/** Check if we have live data from the generator */
function hasLiveData() {
    return Object.keys(liveBuildings).length > 0;
}

// ═══════════════════════════════════════════════════════════════
//  POST /update  — receives real-time data from Python generator
// ═══════════════════════════════════════════════════════════════

app.post('/update', (req, res) => {
    try {
        const d = req.body;
        const bid = d.building_id;
        if (!bid) return res.status(400).json({ error: 'Missing building_id' });

        // Store latest snapshot
        liveBuildings[bid] = {
            id: bid,
            name: BUILDING_META[bid]?.name || bid,
            building_type: d.building_type || BUILDING_META[bid]?.btype || 'Unknown',
            sim_minute: d.sim_minute,
            hour_of_day: d.hour_of_day,
            solar_kw: d.solar_kw,
            base_kwh: d.base_kwh,
            spike_kwh: d.spike_kwh,
            total_drained_kwh: d.total_drained_kwh,
            battery_kwh: d.battery_kwh,
            battery_cap: d.battery_cap,
            is_deficit: d.is_deficit,
            spike_active: d.spike_active,
            spike_mins_left: d.spike_mins_left,
            // Derived fields for the frontend
            solar: Math.round(d.solar_kw || 0),
            load: Math.round((d.total_drained_kwh || 0) * 60),   // kWh/min → approx kW
            battery: d.battery_cap > 0 ? Math.round((d.battery_kwh / d.battery_cap) * 100) : 0,
            status: d.is_deficit ? 'Deficit' : 'Surplus',
            last_updated: Date.now(),
        };

        // Append to history
        if (!buildingHistory[bid]) buildingHistory[bid] = [];
        buildingHistory[bid].push({
            sim_minute: d.sim_minute,
            hour_of_day: d.hour_of_day,
            solar_kw: d.solar_kw,
            solar_output_kw: d.solar_kw / 60,   // per-minute for LSTM compatibility
            consumption_kw: d.total_drained_kwh,
            battery_kwh: d.battery_kwh,
            battery_cap: d.battery_cap,
            is_deficit: d.is_deficit,
            net_flow_kw: (d.solar_kw / 60) - d.total_drained_kwh,
            total_drained_kwh: d.total_drained_kwh,
            spike_active: d.spike_active,
        });
        if (buildingHistory[bid].length > MAX_HISTORY) {
            buildingHistory[bid] = buildingHistory[bid].slice(-MAX_HISTORY);
        }

        res.json({ status: 'ok' });
    } catch (err) {
        console.error('[/update] Error:', err.message);
        res.status(500).json({ error: 'Internal error' });
    }
});

// ─── Health check ──────────────────────────────────────────────
app.get('/api/health', (_req, res) => {
    res.json({
        status: 'ok',
        timestamp: new Date().toISOString(),
        liveBuildings: Object.keys(liveBuildings).length,
        hasLiveData: hasLiveData(),
    });
});

// ─── Building data ─────────────────────────────────────────────
app.get('/api/buildings', (_req, res) => {
    if (hasLiveData()) {
        const live = Object.values(liveBuildings).map(b => ({
            id: b.id,
            name: b.name,
            building_type: b.building_type,
            solar: b.solar,
            load: b.load,
            battery: b.battery,
            status: b.status,
            solar_kw: b.solar_kw,
            total_drained_kwh: b.total_drained_kwh,
            battery_kwh: b.battery_kwh,
            battery_cap: b.battery_cap,
            is_deficit: b.is_deficit,
            spike_active: b.spike_active,
            spike_mins_left: b.spike_mins_left,
            sim_minute: b.sim_minute,
            hour_of_day: b.hour_of_day,
        }));
        return res.json(live);
    }
    // Fallback: use time-varying simulated data
    const live = getSimulatedBuildings();
    res.json(live);
});

// ─── Building simulation states (detailed for Dashboard) ──────
app.get('/api/buildings/states', (_req, res) => {
    if (hasLiveData()) {
        const states = {};
        for (const [bid, b] of Object.entries(liveBuildings)) {
            states[bid] = {
                id: bid,
                type: b.building_type,
                solar_kw: b.solar_kw,
                total_drained_kwh: b.total_drained_kwh,
                battery_kwh: b.battery_kwh,
                battery_cap: b.battery_cap,
                is_deficit: b.is_deficit,
                spike_active: b.spike_active,
                sim_minute: b.sim_minute,
                hour_of_day: b.hour_of_day,
            };
        }
        return res.json(states);
    }
    // Fallback: generate mock states
    const hour = (Date.now() / 60000) % 24;
    const states = {};
    for (const fb of FALLBACK_BUILDINGS) {
        states[fb.id] = {
            id: fb.id,
            type: BUILDING_META[fb.id]?.btype || 'Unknown',
            solar_kw: fb.solar / 60 + (Math.random() - 0.5) * 0.3,
            total_drained_kwh: fb.load / 2000 + (Math.random() - 0.5) * 0.005,
            battery_kwh: (fb.battery / 100) * 15,
            battery_cap: 15,
            is_deficit: fb.status === 'Deficit',
            spike_active: Math.random() < 0.1,
            sim_minute: Math.floor(Date.now() / 1000) % 10000,
            hour_of_day: hour,
        };
    }
    res.json(states);
});

// ─── Building history (for Charts) ────────────────────────────
app.get('/api/buildings/history', (_req, res) => {
    const result = {};
    for (const bid of ['B1', 'B2', 'B3', 'B4', 'B5']) {
        const hist = buildingHistory[bid] || [];
        if (hist.length > 0) {
            result[bid] = hist.slice(-60).map(h => ({
                hour_of_day: h.hour_of_day,
                battery_kwh: h.battery_kwh,
                solar_kw: h.solar_kw,
                total_drained_kwh: h.total_drained_kwh,
                net_flow_kw: h.net_flow_kw,
            }));
        } else {
            // Generate fallback history
            const baseSolar = { B1: 2.1, B2: 1.5, B3: 1.8, B4: 1.9, B5: 2.6 };
            const baseDrain = { B1: 0.031, B2: 0.030, B3: 0.028, B4: 0.031, B5: 0.038 };
            const baseBat = { B1: 10, B2: 7, B3: 15, B4: 8, B5: 12 };
            const points = 40;
            result[bid] = Array.from({ length: points }, (_, i) => {
                const hour = 13.5 + (i * 2) / points;
                return {
                    hour_of_day: +hour.toFixed(2),
                    battery_kwh: Math.max(0.5, baseBat[bid] - (i * baseBat[bid] * 0.3) / points + (Math.random() - 0.5) * 0.5),
                    solar_kw: Math.max(0, baseSolar[bid] * (1 - i / (points * 1.2)) + (Math.random() - 0.5) * 0.3),
                    total_drained_kwh: baseDrain[bid] + (Math.random() - 0.3) * 0.01,
                    net_flow_kw: 0,
                };
            });
        }
    }
    res.json(result);
});

// ─── Building predictions (ML-derived) ────────────────────────
app.get('/api/buildings/predictions', (_req, res) => {
    const predictions = {};
    const deficitBuildings = new Set(['B2', 'B4']);
    for (const bid of ['B1', 'B2', 'B3', 'B4', 'B5']) {
        const live = liveBuildings[bid];
        if (live) {
            // Derive predictions from live state
            const isDef = live.is_deficit;
            const batteryPct = live.battery_cap > 0 ? live.battery_kwh / live.battery_cap : 0.5;
            const netFlow = (live.solar_kw / 60) - live.total_drained_kwh;
            predictions[bid] = {
                predicted_net_kwh: netFlow + (Math.random() - 0.5) * 0.01,
                deficit_probability: isDef
                    ? Math.min(0.95, 0.4 + (1 - batteryPct) * 0.4 + Math.random() * 0.1)
                    : Math.max(0.02, batteryPct * 0.1 + Math.random() * 0.05),
                buffer_minutes: isDef
                    ? Math.floor(20 + batteryPct * 100)
                    : Math.floor(60 + batteryPct * 80),
            };
        } else {
            // Fallback mock predictions
            const isDef = deficitBuildings.has(bid);
            predictions[bid] = {
                predicted_net_kwh: isDef ? -(Math.random() * 0.06 + 0.02) : (Math.random() * 0.06 + 0.01),
                deficit_probability: isDef ? 0.3 + Math.random() * 0.2 : Math.random() * 0.15,
                buffer_minutes: isDef ? Math.floor(30 + Math.random() * 100) : Math.floor(50 + Math.random() * 80),
            };
        }
    }
    res.json(predictions);
});

// ─── Central battery / grid overview ──────────────────────────
app.get('/api/grid/overview', (_req, res) => {
    if (hasLiveData()) {
        const buildings = Object.values(liveBuildings);
        const totalSolar = buildings.reduce((s, b) => s + (b.solar_kw || 0), 0);
        const totalDrain = buildings.reduce((s, b) => s + (b.total_drained_kwh || 0) * 60, 0);
        const totalBattery = buildings.reduce((s, b) => s + (b.battery_kwh || 0), 0);
        const totalBatteryCap = buildings.reduce((s, b) => s + (b.battery_cap || 15), 0);
        const deficitCount = buildings.filter(b => b.is_deficit).length;

        return res.json({
            demand: Math.round(totalDrain),
            generation: Math.round(totalSolar),
            frequency: +(49.9 + Math.random() * 0.2).toFixed(3),
            centralBattery: totalBatteryCap > 0 ? Math.round((totalBattery / totalBatteryCap) * 100) : 50,
            gridStability: Math.max(40, 95 - deficitCount * 10 + Math.round((Math.random() - 0.5) * 6)),
            status: 'online',
            totalBatteryKwh: +totalBattery.toFixed(2),
            totalBatteryCap: +totalBatteryCap.toFixed(2),
            buildingCount: buildings.length,
            deficitCount,
            surplusCount: buildings.length - deficitCount,
        });
    }
    // Fallback
    const totalSolar = FALLBACK_BUILDINGS.reduce((sum, b) => sum + b.solar, 0);
    const totalLoad = FALLBACK_BUILDINGS.reduce((sum, b) => sum + b.load, 0);
    res.json({
        demand: totalLoad + Math.round(Math.random() * 100),
        generation: totalSolar + Math.round(Math.random() * 80),
        frequency: +(49.9 + Math.random() * 0.2).toFixed(3),
        centralBattery: 85 + Math.round((Math.random() - 0.5) * 6),
        gridStability: 76 + Math.round((Math.random() - 0.5) * 8),
        status: 'online',
    });
});

// ─── P2P Energy Transactions ───────────────────────────────────
const transactions = [
    { id: 1, from: 'Building 2', to: 'Building 3', energy: 15, status: 'In Progress', time: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }) },
    { id: 2, from: 'Building 4', to: 'Building 1', energy: 10, status: 'Completed', time: '12:30 PM' },
    { id: 3, from: 'Building 5', to: 'Building 3', energy: 12, status: 'Completed', time: '12:15 PM' },
    { id: 4, from: 'Building 1', to: 'Building 4', energy: 8, status: 'Completed', time: '12:05 PM' },
    { id: 5, from: 'Building 2', to: 'Building 5', energy: 8, status: 'Pending', time: '12:05 AM' },
    { id: 6, from: 'Building 4', to: 'Central Battery', energy: 25, status: 'Completed', time: '11:30 AM' },
];

app.get('/api/transactions', (_req, res) => {
    res.json(transactions);
});

// Store new trade
app.post('/api/trades', async (req, res) => {
    try {
        const { from, to, energy, price, txHash, status } = req.body;

        const newTrade = {
            id: transactions.length + 1,
            from,
            to,
            energy,
            price,
            status: status || 'Completed',
            time: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
            txHash
        };

        // 1. Add to in-memory store for immediate UI update
        transactions.unshift(newTrade);
        if (transactions.length > 20) transactions.pop();

        // 2. Persist to Supabase (best-effort)
        try {
            const { error } = await supabase
                .from('transactions')
                .insert([{
                    from_entity: from,
                    to_entity: to,
                    energy_amount: energy,
                    price_per_unit: price,
                    tx_hash: txHash,
                    status: status || 'Completed'
                }]);

            if (error) console.warn('Supabase insert failed:', error.message);
        } catch (err) {
            console.warn('Supabase error:', err.message);
        }

        res.status(201).json({ success: true, trade: newTrade });
    } catch (error) {
        console.error('Error saving trade:', error);
        res.status(500).json({ success: false, error: 'Failed to save trade' });
    }
});

// ═══════════════════════════════════════════════════════════════
//  AUTO-TRADE SYSTEM
// ═══════════════════════════════════════════════════════════════

// Wallet addresses for each building (replace with real Sepolia addresses)
const BUILDING_WALLETS = {
    B1: '0x0000000000000000000000000000000000000001',
    B2: '0x1111111111111111111111111111111111111111',
    B3: '0x2222222222222222222222222222222222222222',
    B4: '0x3333333333333333333333333333333333333333',
    B5: '0x4444444444444444444444444444444444444444',
};

// Building display names for the frontend
const BUILDING_NAMES = {
    B1: 'Building 1',
    B2: 'Building 2',
    B3: 'Building 3',
    B4: 'Building 4',
    B5: 'Building 5',
};

// Price per kWh in Wei (0.00001 ETH)
const PRICE_PER_KWH_WEI = '10000000000000'; // 0.00001 ETH

/**
 * GET /api/auto-trade/check
 * 
 * Scans all buildings. For each building in deficit, finds the building
 * with the maximum surplus and returns a trade recommendation.
 */
app.get('/api/auto-trade/check', (_req, res) => {
    try {
        const allBuildings = hasLiveData()
            ? Object.values(liveBuildings)
            : getSimulatedBuildings();

        // Find deficit buildings
        const deficitBuildings = allBuildings.filter(b => b.is_deficit || b.status === 'Deficit');

        // Find surplus buildings and compute surplus amount
        const surplusBuildings = allBuildings
            .filter(b => !b.is_deficit && b.status !== 'Deficit')
            .map(b => ({
                ...b,
                surplusKwh: Math.max(0, (b.solar_kw || b.solar || 0) - (b.total_drained_kwh * 60 || b.load || 0)),
            }))
            .filter(b => b.surplusKwh > 0)
            .sort((a, b_item) => b_item.surplusKwh - a.surplusKwh); // highest surplus first

        if (deficitBuildings.length === 0 || surplusBuildings.length === 0) {
            return res.json({ needed: false, trades: [], reason: 'No deficit or no surplus buildings' });
        }

        const trades = [];

        for (const buyer of deficitBuildings) {
            // Pick the seller with the highest surplus
            const seller = surplusBuildings[0];
            if (!seller) continue;

            const deficitKwh = Math.max(0,
                (buyer.total_drained_kwh * 60 || buyer.load || 0) -
                (buyer.solar_kw || buyer.solar || 0)
            );

            if (deficitKwh <= 0) continue;

            // Trade amount = min(deficit, seller surplus)
            const tradeAmountKwh = Math.min(deficitKwh, seller.surplusKwh);
            const tradeAmountInt = Math.ceil(tradeAmountKwh);

            // Calculate total price in Wei
            const totalPriceWei = (BigInt(PRICE_PER_KWH_WEI) * BigInt(tradeAmountInt)).toString();

            trades.push({
                buyerBuildingId: buyer.id,
                buyerName: BUILDING_NAMES[buyer.id] || buyer.name || buyer.id,
                sellerBuildingId: seller.id,
                sellerName: BUILDING_NAMES[seller.id] || seller.name || seller.id,
                sellerAddress: BUILDING_WALLETS[seller.id],
                deficitKwh: +deficitKwh.toFixed(2),
                surplusKwh: +seller.surplusKwh.toFixed(2),
                tradeAmountKwh: tradeAmountInt,
                pricePerKwhWei: PRICE_PER_KWH_WEI,
                totalPriceWei,
            });
        }

        res.json({ needed: trades.length > 0, trades });
    } catch (err) {
        console.error('[/api/auto-trade/check] Error:', err.message);
        res.status(500).json({ needed: false, trades: [], error: 'Internal error' });
    }
});

/**
 * POST /api/auto-trade/execute
 * 
 * Called by the frontend after a successful on-chain transaction.
 * Logs the trade and adjusts in-memory building energy values.
 */
app.post('/api/auto-trade/execute', async (req, res) => {
    try {
        const { buyerBuildingId, sellerBuildingId, energyKwh, txHash, priceWei } = req.body;

        // Adjust in-memory live data if available
        if (liveBuildings[sellerBuildingId]) {
            const seller = liveBuildings[sellerBuildingId];
            seller.solar_kw = Math.max(0, (seller.solar_kw || 0) - energyKwh);
            seller.solar = Math.max(0, (seller.solar || 0) - Math.round(energyKwh));
        }
        if (liveBuildings[buyerBuildingId]) {
            const buyer = liveBuildings[buyerBuildingId];
            buyer.battery_kwh = Math.min(buyer.battery_cap, (buyer.battery_kwh || 0) + energyKwh);
            buyer.battery = buyer.battery_cap > 0
                ? Math.round((buyer.battery_kwh / buyer.battery_cap) * 100)
                : buyer.battery;
        }

        // Create trade record
        const newTrade = {
            id: transactions.length + 1,
            from: BUILDING_NAMES[sellerBuildingId] || sellerBuildingId,
            to: BUILDING_NAMES[buyerBuildingId] || buyerBuildingId,
            energy: energyKwh,
            status: 'Completed',
            time: new Date().toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', hour12: true }),
            txHash,
            type: 'auto',
        };
        transactions.unshift(newTrade);
        if (transactions.length > 20) transactions.pop();

        // Persist to Supabase (best-effort)
        try {
            const { error } = await supabase
                .from('transactions')
                .insert([{
                    from_entity: newTrade.from,
                    to_entity: newTrade.to,
                    energy_amount: energyKwh,
                    price_per_unit: 0.00001,
                    tx_hash: txHash,
                    status: 'Completed',
                    type: 'auto',
                }]);
            if (error) console.warn('Supabase auto-trade insert failed:', error.message);
        } catch (err) {
            console.warn('Supabase error:', err.message);
        }

        res.status(201).json({ success: true, trade: newTrade });
    } catch (error) {
        console.error('Error executing auto-trade:', error);
        res.status(500).json({ success: false, error: 'Failed to execute auto-trade' });
    }
});

// ─── Market prices ─────────────────────────────────────────────
app.get('/api/market/prices', (_req, res) => {
    res.json({
        gridBuy: +(0.13 + Math.random() * 0.04).toFixed(2),
        gridSell: +(0.06 + Math.random() * 0.04).toFixed(2),
        p2pAverage: +(0.10 + Math.random() * 0.04).toFixed(2),
        trend: Math.random() > 0.5 ? 'up' : 'down',
    });
});

// ─── Carbon credits ────────────────────────────────────────────
app.get('/api/carbon', (_req, res) => {
    // If we have live data, derive carbon stats from solar generation
    let totalSolarKw = 0;
    if (hasLiveData()) {
        totalSolarKw = Object.values(liveBuildings).reduce((s, b) => s + (b.solar_kw || 0), 0);
    }
    const baseEarned = hasLiveData() ? Math.round(300 + totalSolarKw * 3) : 450;

    res.json({
        totalEarned: baseEarned,
        traded: Math.round(baseEarned * 0.27),
        co2Offset: +(baseEarned * 0.00267).toFixed(1),
        rating: baseEarned > 400 ? 'A+' : baseEarned > 300 ? 'A' : 'B+',
        offsetSources: [
            { name: 'Solar Energy', value: Math.round(baseEarned * 1.15) },
            { name: 'Wind Power', value: Math.round(baseEarned * 0.69) },
            { name: 'Reforestation', value: Math.round(baseEarned * 0.38) },
        ],
        stats: [
            { label: 'Total Credits Earned', value: String(baseEarned), unit: 'CC', change: '+12%', color: 'text-[var(--color-accent-green)]' },
            { label: 'Credits Traded', value: String(Math.round(baseEarned * 0.27)), unit: 'CC', change: '+5%', color: 'text-[var(--color-accent-cyan)]' },
            { label: 'CO2 Offset', value: (baseEarned * 0.00267).toFixed(1), unit: 'Tons', change: '+8%', color: 'text-white' },
        ],
    });
});

// ─── Forecast data ─────────────────────────────────────────────
app.get('/api/forecast', (_req, res) => {
    // If we have live history, use it to generate more realistic forecasts
    const data = Array.from({ length: 24 }, (_, i) => {
        let actual, predicted;
        if (hasLiveData()) {
            const buildings = Object.values(liveBuildings);
            const totalLoad = buildings.reduce((s, b) => s + (b.total_drained_kwh || 0) * 60, 0);
            const base = Math.max(200, totalLoad * 10);
            actual = Math.round(base + Math.sin(i / 3) * (base * 0.12));
            predicted = Math.round(actual + (Math.random() - 0.5) * (base * 0.02));
        } else {
            actual = Math.round(4200 + Math.sin(i / 3) * 500);
            predicted = Math.round(4200 + Math.sin(i / 3) * 500 + (Math.random() - 0.5) * 100);
        }
        return { time: `${i}:00`, actual, predicted };
    });

    // Compute building surplus/deficit for the chart
    let buildingSurplusDeficit;
    if (hasLiveData()) {
        buildingSurplusDeficit = Object.values(liveBuildings).map(b => ({
            name: b.name,
            value: b.solar - b.load,
            building: b.name,
        }));
    } else {
        buildingSurplusDeficit = FALLBACK_BUILDINGS.map(b => ({
            name: b.name.split(' ')[0] + ' ' + (b.name.split(' ')[1] || ''),
            value: b.solar - b.load,
            building: b.name,
        }));
    }

    res.json({
        data,
        buildingSurplusDeficit,
        confidence: hasLiveData() ? 96.7 : 98.2,
        model: 'LSTM v2.4',
    });
});

// ─── Auth: get current user (verify JWT) ───────────────────────
app.get('/api/auth/user', async (req, res) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) return res.status(401).json({ error: 'No token provided' });

    const token = authHeader.replace('Bearer ', '');
    const { data: { user }, error } = await supabase.auth.getUser(token);

    if (error || !user) return res.status(401).json({ error: 'Invalid token' });

    res.json({
        id: user.id,
        email: user.email,
        name: user.user_metadata?.full_name || 'Operator',
        created_at: user.created_at,
    });
});

// ─── Start server ──────────────────────────────────────────────
app.listen(PORT, () => {
    console.log(`[SERVER] Running on http://localhost:${PORT}`);
    console.log(`[SERVER] Supabase: ${process.env.SUPABASE_URL ? 'Connected' : 'NOT configured'}`);
    console.log(`[SERVER] Live data: waiting for Python generator to connect...`);
});
