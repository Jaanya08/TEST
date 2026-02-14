// ═══════════════════════════════════════════════════════════════
//  API Service — Central data fetching layer
//  All frontend pages use this instead of direct mock imports
// ═══════════════════════════════════════════════════════════════

const API_BASE = (import.meta as any).env?.VITE_API_URL || 'http://localhost:5000';

async function apiFetch<T>(path: string): Promise<T> {
    const res = await fetch(`${API_BASE}${path}`);
    if (!res.ok) throw new Error(`API ${path} failed: ${res.status}`);
    return res.json();
}

// ── Types ─────────────────────────────────────────────────────

export interface BuildingData {
    id: string;
    name: string;
    building_type?: string;
    solar: number;
    load: number;
    battery: number;
    status: string;
    solar_kw?: number;
    total_drained_kwh?: number;
    battery_kwh?: number;
    battery_cap?: number;
    is_deficit?: boolean;
    spike_active?: boolean;
    spike_mins_left?: number;
    sim_minute?: number;
    hour_of_day?: number;
}

export interface BuildingSimState {
    id: string;
    type: string;
    solar_kw: number;
    total_drained_kwh: number;
    battery_kwh: number;
    battery_cap: number;
    is_deficit: boolean;
    spike_active: boolean;
    sim_minute: number;
    hour_of_day: number;
}

export interface BuildingPrediction {
    predicted_net_kwh: number;
    deficit_probability: number;
    buffer_minutes: number;
}

export interface GridOverview {
    demand: number;
    generation: number;
    frequency: number;
    centralBattery: number;
    gridStability: number;
    status: string;
    totalBatteryKwh?: number;
    totalBatteryCap?: number;
    buildingCount?: number;
    deficitCount?: number;
    surplusCount?: number;
}

export interface HistoryPoint {
    hour_of_day: number;
    battery_kwh: number;
    solar_kw: number;
    total_drained_kwh: number;
    net_flow_kw?: number;
}

export interface ForecastResponse {
    data: { time: string; actual: number; predicted: number }[];
    buildingSurplusDeficit: { name: string; value: number; building: string }[];
    confidence: number;
    model: string;
}

export interface CarbonResponse {
    totalEarned: number;
    traded: number;
    co2Offset: number;
    rating: string;
    offsetSources: { name: string; value: number }[];
    stats: { label: string; value: string; unit: string; change: string; color: string }[];
}

export interface MarketPrices {
    gridBuy: number;
    gridSell: number;
    p2pAverage: number;
    trend: string;
}

// ── API Functions ─────────────────────────────────────────────

export async function fetchBuildings(): Promise<BuildingData[]> {
    return apiFetch<BuildingData[]>('/api/buildings');
}

export async function fetchBuildingStates(): Promise<Record<string, BuildingSimState>> {
    return apiFetch<Record<string, BuildingSimState>>('/api/buildings/states');
}

export async function fetchBuildingPredictions(): Promise<Record<string, BuildingPrediction>> {
    return apiFetch<Record<string, BuildingPrediction>>('/api/buildings/predictions');
}

export async function fetchBuildingHistory(): Promise<Record<string, HistoryPoint[]>> {
    return apiFetch<Record<string, HistoryPoint[]>>('/api/buildings/history');
}

export async function fetchGridOverview(): Promise<GridOverview> {
    return apiFetch<GridOverview>('/api/grid/overview');
}

export async function fetchTransactions() {
    return apiFetch<any[]>('/api/transactions');
}

export async function fetchForecast(): Promise<ForecastResponse> {
    return apiFetch<ForecastResponse>('/api/forecast');
}

export async function fetchCarbon(): Promise<CarbonResponse> {
    return apiFetch<CarbonResponse>('/api/carbon');
}

export async function fetchMarketPrices(): Promise<MarketPrices> {
    return apiFetch<MarketPrices>('/api/market/prices');
}

// ── Auto-Trade Types & Functions ──────────────────────────────

export interface AutoTradeItem {
    buyerBuildingId: string;
    buyerName: string;
    sellerBuildingId: string;
    sellerName: string;
    sellerAddress: string;
    deficitKwh: number;
    surplusKwh: number;
    tradeAmountKwh: number;
    pricePerKwhWei: string;
    totalPriceWei: string;
}

export interface AutoTradeCheck {
    needed: boolean;
    trades: AutoTradeItem[];
    reason?: string;
}

export async function fetchAutoTradeCheck(): Promise<AutoTradeCheck> {
    return apiFetch<AutoTradeCheck>('/api/auto-trade/check');
}

export async function postAutoTradeExecute(data: {
    buyerBuildingId: string;
    sellerBuildingId: string;
    energyKwh: number;
    txHash: string;
    priceWei: string;
}): Promise<{ success: boolean; trade: any }> {
    const res = await fetch(`${API_BASE}/api/auto-trade/execute`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(data),
    });
    if (!res.ok) throw new Error(`Auto-trade execute failed: ${res.status}`);
    return res.json();
}

export { API_BASE };
