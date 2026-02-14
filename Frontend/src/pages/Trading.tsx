import React, { useState, useEffect, useCallback } from 'react';
import { fetchBuildings, fetchGridOverview, API_BASE } from '../services/api';
import {
    Battery, Activity, CheckCircle2, AlertCircle,
    Loader2, Zap, Building2, Power, ExternalLink,
    Shield, Clock
} from 'lucide-react';
import { ethers } from "ethers";
import { useAutoTrade } from '../hooks/useAutoTrade';
import type { AutoTradeStatus } from '../hooks/useAutoTrade';

/* ========================= */
/* CONTRACT CONFIG */
/* ========================= */

const CONTRACT_ADDRESS = "0xf3bab00B2cEF39f27838F1dDec3CA52db13Ee9eA";

const CONTRACT_ABI = [
    {
        "inputs": [
            { "internalType": "address", "name": "_seller", "type": "address" },
            { "internalType": "uint256", "name": "_energy", "type": "uint256" }
        ],
        "name": "buyFromBuilding",
        "outputs": [],
        "stateMutability": "payable",
        "type": "function"
    },
    {
        "inputs": [{ "internalType": "uint256", "name": "_energy", "type": "uint256" }],
        "name": "buyFromCentral",
        "outputs": [],
        "stateMutability": "payable",
        "type": "function"
    },
    {
        "inputs": [{ "internalType": "uint256", "name": "_energy", "type": "uint256" }],
        "name": "buyFromGrid",
        "outputs": [],
        "stateMutability": "payable",
        "type": "function"
    }
];

/* ========================= */
/* HARDCODED SELLER ADDRESSES */
/* ========================= */

const buildingAddresses: Record<string, string> = {
    "Building 2": "0x1111111111111111111111111111111111111111",
    "Building 3": "0x2222222222222222222222222222222222222222",
    "Building 4": "0x3333333333333333333333333333333333333333",
    "Building 5": "0x4444444444444444444444444444444444444444",
};

interface EnergyOffer {
    id: string;
    source: string;
    type: 'Grid' | 'Battery' | 'P2P';
    amount: number;
    price: number;
}

const mockOffers: EnergyOffer[] = [
    { id: 'grid-01', source: 'Main Power Grid', type: 'Grid', amount: 9999, price: 0.30 },
    { id: 'bat-01', source: 'Central Battery Storage', type: 'Battery', amount: 850, price: 0.22 },
    { id: 'b2', source: 'Building 2', type: 'P2P', amount: 15.5, price: 0.12 },
    { id: 'b3', source: 'Building 3', type: 'P2P', amount: 8.2, price: 0.11 },
    { id: 'b4', source: 'Building 4', type: 'P2P', amount: 12.0, price: 0.13 },
    { id: 'b5', source: 'Building 5', type: 'P2P', amount: 20.4, price: 0.14 },
];

/* ========================= */
/* STATUS HELPER              */
/* ========================= */

const STATUS_CONFIG: Record<AutoTradeStatus, { label: string; color: string; pulse: boolean }> = {
    'idle': { label: 'MONITORING', color: 'var(--color-positive)', pulse: true },
    'paused': { label: 'PAUSED', color: 'var(--color-text-muted)', pulse: false },
    'checking': { label: 'SCANNING...', color: 'var(--color-accent)', pulse: true },
    'trade-detected': { label: 'TRADE DETECTED', color: 'var(--color-warning)', pulse: true },
    'awaiting-wallet': { label: 'AWAITING METAMASK', color: '#a78bfa', pulse: true },
    'confirming': { label: 'CONFIRMING ON-CHAIN', color: 'var(--color-accent)', pulse: true },
    'completed': { label: 'TRADE COMPLETE', color: 'var(--color-positive)', pulse: false },
    'error': { label: 'ERROR', color: 'var(--color-negative)', pulse: false },
    'cooldown': { label: 'COOLDOWN', color: 'var(--color-warning)', pulse: false },
};

const Trading: React.FC = () => {
    // --- STATE ---
    const [offers, setOffers] = useState<EnergyOffer[]>(mockOffers);
    const [offerStatus, setOfferStatus] = useState<Record<string, 'idle' | 'processing' | 'completed'>>({});
    const [requiredEnergy, setRequiredEnergy] = useState<number>(0);

    // --- MODAL STATE ---
    const [showModal, setShowModal] = useState(false);
    const [selectedOffer, setSelectedOffer] = useState<EnergyOffer | null>(null);
    const [buyAmount, setBuyAmount] = useState<string>('');

    // --- LIVE DATA STATE ---
    const [buyers, setBuyers] = useState(2);
    const [sellers, setSellers] = useState(3);
    const [centralBattery, setCentralBattery] = useState(85);
    const [gridStability, setGridStability] = useState(76);

    // --- AUTO-TRADE HOOK ---
    const autoTrade = useAutoTrade();

    const refreshStats = useCallback(async () => {
        try {
            const [buildings, grid] = await Promise.all([
                fetchBuildings(),
                fetchGridOverview(),
            ]);
            setBuyers(buildings.filter(b => b.status === 'Deficit').length);
            setSellers(buildings.filter(b => b.status === 'Surplus').length);
            setCentralBattery(grid.centralBattery);
            setGridStability(grid.gridStability);

            // Update Building 1's deficit/surplus from real data
            const b1 = buildings.find(b => b.id === 'B1');
            if (b1) {
                const deficit = b1.load - b1.solar;
                setRequiredEnergy(deficit > 0 ? +deficit.toFixed(1) : +(deficit).toFixed(1));
            }

            // Update P2P offer amounts from live data (surplus buildings)
            setOffers(prev => prev.map(offer => {
                if (offer.type !== 'P2P') return offer;
                const matchingBuilding = buildings.find(b => b.name === offer.source || `Building ${b.id.replace('B', '')}` === offer.source);
                if (matchingBuilding && matchingBuilding.status === 'Surplus') {
                    return { ...offer, amount: Math.max(0, +(matchingBuilding.solar - matchingBuilding.load).toFixed(1)) };
                } else if (matchingBuilding && matchingBuilding.status === 'Deficit') {
                    return { ...offer, amount: 0 };
                }
                return offer;
            }));
        } catch (err) {
            console.warn('[Trading] API fallback:', err);
        }
    }, []);

    useEffect(() => {
        refreshStats();
        const id = setInterval(refreshStats, 5000);
        return () => clearInterval(id);
    }, []);

    // --- DERIVED STATE ---
    const currentStatus = requiredEnergy > 0 ? 'Deficit' : 'Surplus';
    const displayedEnergy = Math.abs(requiredEnergy);
    const statusColor = requiredEnergy > 0 ? 'var(--color-negative)' : 'var(--color-positive)';
    const stabilityColor = gridStability >= 70 ? 'var(--color-positive)' : gridStability >= 40 ? 'var(--color-warning)' : 'var(--color-negative)';

    // --- HANDLERS ---
    const handleBuyClick = (offer: EnergyOffer) => {
        setSelectedOffer(offer);
        setBuyAmount('');
        setShowModal(true);
    };

    const handleConfirmBuy = async () => {
        if (!selectedOffer) return;

        const amount = Number(buyAmount);

        // Validation
        if (!amount || amount <= 0) {
            alert("Please enter a valid amount");
            return;
        }
        if (amount > selectedOffer.amount) {
            alert("Invalid input: Exceeds available amount");
            setShowModal(false);
            return;
        }

        // Close modal and start transaction
        setShowModal(false);
        await executeTransaction(selectedOffer, amount);
    };

    const executeTransaction = async (offer: EnergyOffer, amountToBuy: number) => {
        const id = offer.id;
        try {
            if (!(window as any).ethereum) {
                alert("MetaMask not detected. Kindly download the required extensions and log in.");
                return;
            }

            setOfferStatus(prev => ({ ...prev, [id]: 'processing' }));

            const provider = new ethers.BrowserProvider((window as any).ethereum);
            const signer = await provider.getSigner();
            const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);

            let tx;
            const GRID_PRICE = ethers.parseEther("0.00002");
            const CENTRAL_PRICE = ethers.parseEther("0.000015");
            const HOUSE_PRICE = ethers.parseEther("0.00001");

            if (offer.type === "Grid") {
                tx = await contract.buyFromGrid(Math.floor(amountToBuy), { value: GRID_PRICE });
            } else if (offer.type === "Battery") {
                tx = await contract.buyFromCentral(Math.floor(amountToBuy), { value: CENTRAL_PRICE });
            } else if (offer.type === "P2P") {
                const sellerAddress = buildingAddresses[offer.source];
                if (!sellerAddress) throw new Error("Seller address missing");
                tx = await contract.buyFromBuilding(sellerAddress, Math.floor(amountToBuy), { value: HOUSE_PRICE });
            }

            await tx.wait();

            // Success: Update UI
            setRequiredEnergy(prev => prev - amountToBuy);
            setOffers(prev => prev.map(o => o.id === id ? { ...o, amount: o.amount - amountToBuy } : o));
            setOfferStatus(prev => ({ ...prev, [id]: 'completed' }));

            // Save to Backend
            try {
                await fetch(`${API_BASE}/api/trades`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({
                        from: offer.source,
                        to: 'Building 1',
                        energy: amountToBuy,
                        price: offer.price,
                        txHash: tx.hash,
                        status: 'Completed'
                    })
                });
            } catch (err) {
                console.error("Failed to save trade:", err);
            }

        } catch (error) {
            console.error(error);
            alert("Transaction failed/cancelled");
            setOfferStatus(prev => ({ ...prev, [id]: 'idle' }));
        }
    };

    // --- Auto-trade status config ---
    const atStatus = STATUS_CONFIG[autoTrade.status];

    return (
        <div className="space-y-8 animate-enter relative">
            {/* Header */}
            <div className="flex items-center justify-between">
                <div>
                    <h1 className="text-2xl font-semibold text-white">P2P Energy Transfer Marketplace</h1>
                    <p className="text-xs text-[var(--color-text-muted)] mt-1" style={{ fontFamily: 'var(--font-mono)' }}>
                        BLOCKCHAIN-SETTLED · REAL-TIME TRANSFERS
                    </p>
                </div>
                <div className="flex items-center gap-2">
                    <span className="status-dot status-dot-live bg-[var(--color-positive)]" />
                    <span className="text-xs font-semibold text-[var(--color-positive)]" style={{ fontFamily: 'var(--font-mono)' }}>LIVE</span>
                </div>
            </div>

            {/* ═══════════════════════════════════════════════════════════ */}
            {/* AUTO-TRADE PANEL                                          */}
            {/* ═══════════════════════════════════════════════════════════ */}
            <div
                className="card overflow-hidden"
                style={{
                    borderColor: autoTrade.enabled ? 'rgba(0,229,255,0.25)' : 'var(--color-border)',
                    boxShadow: autoTrade.enabled ? '0 0 30px rgba(0,229,255,0.08)' : 'none',
                    transition: 'border-color 0.4s, box-shadow 0.4s',
                }}
            >
                {/* Auto-trade header */}
                <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-center justify-between">
                    <div className="flex items-center gap-3">
                        <div className="w-10 h-10 rounded-lg flex items-center justify-center"
                            style={{
                                background: autoTrade.enabled
                                    ? 'linear-gradient(135deg, rgba(0,229,255,0.15), rgba(0,255,163,0.1))'
                                    : 'rgba(255,255,255,0.03)',
                                border: `1px solid ${autoTrade.enabled ? 'rgba(0,229,255,0.3)' : 'var(--color-border)'}`,
                            }}
                        >
                            <Shield size={18} style={{ color: autoTrade.enabled ? 'var(--color-accent)' : 'var(--color-text-muted)' }} />
                        </div>
                        <div>
                            <h3 className="text-base font-semibold text-white">Automated Energy Trading</h3>
                            <p className="text-[10px] text-[var(--color-text-muted)]" style={{ fontFamily: 'var(--font-mono)' }}>
                                AUTO-DETECT DEFICIT · AUTO-SELECT BEST LENDER · SEPOLIA SETTLEMENT
                            </p>
                        </div>
                    </div>

                    <div className="flex items-center gap-4">
                        {/* Status badge */}
                        <div className="flex items-center gap-2">
                            <span
                                className="w-2 h-2 rounded-full"
                                style={{
                                    backgroundColor: atStatus.color,
                                    animation: atStatus.pulse ? 'pulse-dot 1.5s infinite' : 'none',
                                }}
                            />
                            <span className="text-[10px] font-bold tracking-wider" style={{ color: atStatus.color, fontFamily: 'var(--font-mono)' }}>
                                {atStatus.label}
                            </span>
                        </div>

                        {/* Toggle switch */}
                        <button
                            onClick={() => autoTrade.setEnabled(!autoTrade.enabled)}
                            className="relative inline-flex items-center h-7 w-14 rounded-full transition-all duration-300 focus:outline-none"
                            style={{
                                backgroundColor: autoTrade.enabled ? 'rgba(0,229,255,0.25)' : 'rgba(255,255,255,0.06)',
                                border: `1px solid ${autoTrade.enabled ? 'rgba(0,229,255,0.5)' : 'var(--color-border)'}`,
                            }}
                        >
                            <span
                                className="inline-block h-5 w-5 rounded-full transition-all duration-300 shadow-lg"
                                style={{
                                    transform: autoTrade.enabled ? 'translateX(30px)' : 'translateX(4px)',
                                    backgroundColor: autoTrade.enabled ? '#00e5ff' : 'var(--color-text-muted)',
                                    boxShadow: autoTrade.enabled ? '0 0 10px rgba(0,229,255,0.5)' : 'none',
                                }}
                            />
                        </button>
                    </div>
                </div>

                {/* Auto-trade body — only shown when enabled */}
                {autoTrade.enabled && (
                    <div className="p-6">
                        {/* Stats row */}
                        <div className="grid grid-cols-1 sm:grid-cols-3 gap-4 mb-6">
                            <div className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg p-4 text-center">
                                <p className="text-[9px] text-[var(--color-text-dim)] uppercase tracking-widest mb-1" style={{ fontFamily: 'var(--font-mono)' }}>
                                    Total Auto-Trades
                                </p>
                                <p className="text-2xl font-bold text-white" style={{ fontFamily: 'var(--font-mono)' }}>
                                    {autoTrade.stats.totalTrades}
                                </p>
                            </div>
                            <div className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg p-4 text-center">
                                <p className="text-[9px] text-[var(--color-text-dim)] uppercase tracking-widest mb-1" style={{ fontFamily: 'var(--font-mono)' }}>
                                    ETH Spent
                                </p>
                                <p className="text-2xl font-bold text-[var(--color-accent)]" style={{ fontFamily: 'var(--font-mono)' }}>
                                    {autoTrade.stats.totalEthSpent.toFixed(6)}
                                </p>
                            </div>
                            <div className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg p-4 text-center">
                                <p className="text-[9px] text-[var(--color-text-dim)] uppercase tracking-widest mb-1" style={{ fontFamily: 'var(--font-mono)' }}>
                                    Energy Acquired
                                </p>
                                <p className="text-2xl font-bold text-[var(--color-positive)]" style={{ fontFamily: 'var(--font-mono)' }}>
                                    {autoTrade.stats.totalEnergyAcquired} <span className="text-sm font-normal text-[var(--color-text-dim)]">kWh</span>
                                </p>
                            </div>
                        </div>

                        {/* Pending trade indicator */}
                        {autoTrade.pendingTrade && (
                            <div
                                className="mb-4 p-4 rounded-lg border flex items-center justify-between"
                                style={{
                                    background: 'linear-gradient(135deg, rgba(0,229,255,0.05), rgba(167,139,250,0.05))',
                                    borderColor: 'rgba(0,229,255,0.3)',
                                }}
                            >
                                <div className="flex items-center gap-3">
                                    <Loader2 size={16} className="animate-spin text-[var(--color-accent)]" />
                                    <div>
                                        <p className="text-sm font-semibold text-white">
                                            {autoTrade.pendingTrade.buyerName} ← {autoTrade.pendingTrade.sellerName}
                                        </p>
                                        <p className="text-[10px] text-[var(--color-text-muted)]" style={{ fontFamily: 'var(--font-mono)' }}>
                                            {autoTrade.pendingTrade.tradeAmountKwh} kWh · {ethers.formatEther(BigInt(autoTrade.pendingTrade.totalPriceWei))} ETH
                                        </p>
                                    </div>
                                </div>
                                <span className="text-[10px] font-bold tracking-wider text-[var(--color-accent)]" style={{ fontFamily: 'var(--font-mono)' }}>
                                    {autoTrade.status === 'awaiting-wallet' ? 'CONFIRM IN METAMASK' : 'CONFIRMING ON-CHAIN...'}
                                </span>
                            </div>
                        )}

                        {/* Error message */}
                        {autoTrade.errorMessage && (
                            <div className="mb-4 p-3 rounded-lg border border-[rgba(248,113,113,0.3)] bg-[rgba(248,113,113,0.05)] flex items-center gap-2">
                                <AlertCircle size={14} className="text-[var(--color-negative)]" />
                                <p className="text-xs text-[var(--color-negative)]">{autoTrade.errorMessage}</p>
                            </div>
                        )}

                        {/* Activity log */}
                        <div>
                            <div className="flex items-center justify-between mb-3">
                                <h4 className="text-sm font-semibold text-white flex items-center gap-2">
                                    <Clock size={14} className="text-[var(--color-text-muted)]" />
                                    Activity Log
                                </h4>
                                <span className="text-[10px] text-[var(--color-text-dim)]" style={{ fontFamily: 'var(--font-mono)' }}>
                                    {autoTrade.log.length} ENTRIES
                                </span>
                            </div>

                            {autoTrade.log.length === 0 ? (
                                <div className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg p-6 text-center">
                                    <Power size={20} className="mx-auto mb-2 text-[var(--color-text-dim)]" />
                                    <p className="text-xs text-[var(--color-text-muted)]">No auto-trades yet. Monitoring for deficit buildings...</p>
                                </div>
                            ) : (
                                <div className="space-y-2 max-h-60 overflow-y-auto pr-1" style={{ scrollbarWidth: 'thin', scrollbarColor: 'var(--color-border) transparent' }}>
                                    {autoTrade.log.map(entry => (
                                        <div
                                            key={entry.id}
                                            className="bg-[var(--color-bg)] border border-[var(--color-border)] rounded-lg p-3 flex items-center justify-between hover:border-[var(--color-accent)] transition-colors"
                                            style={{ transition: 'border-color 0.2s' }}
                                        >
                                            <div className="flex items-center gap-3">
                                                <div className={`w-7 h-7 rounded-md flex items-center justify-center ${entry.status === 'success'
                                                    ? 'bg-[rgba(52,211,153,0.1)] text-[var(--color-positive)]'
                                                    : 'bg-[rgba(248,113,113,0.1)] text-[var(--color-negative)]'
                                                    }`}>
                                                    {entry.status === 'success' ? <CheckCircle2 size={14} /> : <AlertCircle size={14} />}
                                                </div>
                                                <div>
                                                    <p className="text-xs font-semibold text-white">
                                                        {entry.buyerName} ← {entry.sellerName}
                                                    </p>
                                                    <p className="text-[10px] text-[var(--color-text-muted)]" style={{ fontFamily: 'var(--font-mono)' }}>
                                                        {entry.energyKwh} kWh · {entry.ethSpent} ETH
                                                        {entry.error && <span className="text-[var(--color-negative)] ml-2">({entry.error.slice(0, 40)})</span>}
                                                    </p>
                                                </div>
                                            </div>
                                            <div className="text-right flex items-center gap-3">
                                                <span className="text-[10px] text-[var(--color-text-dim)]" style={{ fontFamily: 'var(--font-mono)' }}>
                                                    {entry.timestamp.toLocaleTimeString('en-US', { hour: 'numeric', minute: '2-digit', second: '2-digit', hour12: true })}
                                                </span>
                                                {entry.txHash && (
                                                    <a
                                                        href={`https://sepolia.etherscan.io/tx/${entry.txHash}`}
                                                        target="_blank"
                                                        rel="noopener noreferrer"
                                                        className="text-[var(--color-accent)] hover:text-[#33e0ff] transition-colors"
                                                    >
                                                        <ExternalLink size={12} />
                                                    </a>
                                                )}
                                            </div>
                                        </div>
                                    ))}
                                </div>
                            )}
                        </div>
                    </div>
                )}
            </div>

            {/* B1 Status Banner */}
            <div className={`card p-6 border-l-[4px] bg-gradient-to-r ${requiredEnergy > 0 ? 'border-l-[var(--color-negative)] from-[rgba(248,113,113,0.05)]' : 'border-l-[var(--color-positive)] from-[rgba(52,211,153,0.05)]'} to-transparent transition-colors duration-500`}>
                <div className="flex flex-col md:flex-row items-center justify-between gap-4">
                    <div className="flex items-center gap-4">
                        <div className={`w-12 h-12 rounded-full flex items-center justify-center ${requiredEnergy > 0 ? 'bg-[rgba(248,113,113,0.15)] text-[var(--color-negative)]' : 'bg-[rgba(52,211,153,0.15)] text-[var(--color-positive)]'}`}>
                            <Building2 size={24} />
                        </div>
                        <div>
                            <h2 className="text-lg font-bold text-white">Buying For: Building 1</h2>
                            <p className="text-sm text-[var(--color-text-muted)]">
                                Current Status: <span className="font-semibold" style={{ color: statusColor }}>{currentStatus.toUpperCase()}</span>
                            </p>
                        </div>
                    </div>
                    <div className="flex items-center gap-6">
                        <div className="text-right">
                            <p className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider">
                                {requiredEnergy > 0 ? 'Required Energy' : 'Excess Energy'}
                            </p>
                            <p className="text-2xl font-bold text-white" style={{ fontFamily: 'var(--font-mono)' }}>
                                {displayedEnergy.toFixed(1)} <span className="text-sm font-normal text-[var(--color-text-dim)]">kWh</span>
                            </p>
                        </div>
                        {requiredEnergy > 0 ? (
                            <AlertCircle size={24} className="text-[var(--color-negative)] animate-pulse" />
                        ) : (
                            <CheckCircle2 size={24} className="text-[var(--color-positive)]" />
                        )}
                    </div>
                </div>
            </div>

            {/* Stats Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-5">
                <div className="card p-5">
                    <p className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider mb-2">Current Buyers</p>
                    <div className="flex items-end justify-between">
                        <span className="text-4xl font-bold text-white" style={{ fontFamily: 'var(--font-mono)' }}>{buyers}</span>
                        <span className="flex items-center gap-1.5 text-xs font-semibold text-[var(--color-negative)]">
                            <span className="w-2.5 h-2.5 rounded-full bg-[var(--color-negative)]" /> Deficit
                        </span>
                    </div>
                </div>
                <div className="card p-5">
                    <p className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider mb-2">Current Sellers</p>
                    <div className="flex items-end justify-between">
                        <span className="text-4xl font-bold text-white" style={{ fontFamily: 'var(--font-mono)' }}>{sellers}</span>
                        <span className="flex items-center gap-1.5 text-xs font-semibold text-[var(--color-positive)]">
                            <span className="w-2.5 h-2.5 rounded-full bg-[var(--color-positive)]" /> Surplus
                        </span>
                    </div>
                </div>
                <div className="card p-5">
                    <p className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider mb-2">Central Battery Level</p>
                    <div className="flex items-end justify-between mb-3">
                        <div className="flex items-baseline gap-1">
                            <span className="text-4xl font-bold text-white" style={{ fontFamily: 'var(--font-mono)' }}>{centralBattery}</span>
                            <span className="text-lg text-[var(--color-text-muted)]">%</span>
                        </div>
                        <Battery size={22} className="text-[var(--color-positive)] mb-1" />
                    </div>
                    <div className="w-full h-3 bg-[var(--color-border)] rounded-sm overflow-hidden">
                        <div className="h-full rounded-sm transition-all duration-500" style={{ width: `${centralBattery}%`, background: `linear-gradient(90deg, var(--color-positive), var(--color-accent))` }} />
                    </div>
                </div>
                <div className="card p-5">
                    <p className="text-xs text-[var(--color-text-muted)] uppercase tracking-wider mb-2">Grid Stability Score</p>
                    <div className="flex items-end justify-between mb-3">
                        <div className="flex items-baseline gap-2">
                            <span className="text-4xl font-bold text-white" style={{ fontFamily: 'var(--font-mono)' }}>{gridStability}</span>
                            <span className="text-sm font-semibold" style={{ color: stabilityColor }}>(Stable)</span>
                        </div>
                        <Activity size={22} style={{ color: stabilityColor }} className="mb-1" />
                    </div>
                    <div className="w-full h-3 bg-[var(--color-border)] rounded-sm overflow-hidden">
                        <div className="h-full rounded-sm transition-all duration-500" style={{ width: `${gridStability}%`, background: `linear-gradient(90deg, var(--color-warning), ${stabilityColor})` }} />
                    </div>
                </div>
            </div>

            {/* Available Markets Table */}
            <div className="card overflow-hidden">
                <div className="px-6 py-4 border-b border-[var(--color-border)] flex items-center justify-between">
                    <div>
                        <h3 className="text-base font-semibold text-white">Available Markets (Buy Energy)</h3>
                        <p className="text-xs text-[var(--color-text-muted)] mt-0.5">Select a source to fulfill your {Math.max(0, requiredEnergy).toFixed(1)} kWh deficit</p>
                    </div>
                </div>
                <div className="overflow-x-auto">
                    <table className="data-table">
                        <thead>
                            <tr>
                                <th>From</th>
                                <th>To</th>
                                <th style={{ textAlign: 'center' }}>Available</th>
                                <th style={{ textAlign: 'center' }}>Rate</th>
                                <th style={{ textAlign: 'center' }}>Status</th>
                                <th style={{ textAlign: 'center' }}>Actions</th>
                            </tr>
                        </thead>
                        <tbody>
                            {offers.map((offer) => {
                                const status = offerStatus[offer.id] || 'idle';
                                const isProcessing = status === 'processing';
                                const isCompleted = status === 'completed';
                                return (
                                    <tr key={offer.id}>
                                        <td>
                                            <div className="flex items-center gap-3">
                                                <div className={`w-8 h-8 rounded-md flex items-center justify-center ${offer.type === 'Grid' ? 'bg-[rgba(251,191,36,0.1)] text-[var(--color-warning)]' : offer.type === 'Battery' ? 'bg-[rgba(52,211,153,0.1)] text-[var(--color-positive)]' : 'bg-[rgba(96,165,250,0.1)] text-[var(--color-info)]'}`}>
                                                    {offer.type === 'Grid' && <Zap size={16} />}
                                                    {offer.type === 'Battery' && <Battery size={16} />}
                                                    {offer.type === 'P2P' && <Building2 size={16} />}
                                                </div>
                                                <div>
                                                    <span className="font-semibold text-white text-sm block">{offer.source}</span>
                                                    <span className={`text-[10px] px-1.5 py-0.5 rounded ${offer.type === 'Grid' ? 'bg-[rgba(251,191,36,0.1)] text-[var(--color-warning)]' : offer.type === 'Battery' ? 'bg-[rgba(52,211,153,0.1)] text-[var(--color-positive)]' : 'bg-[rgba(96,165,250,0.1)] text-[var(--color-info)]'}`} style={{ fontFamily: 'var(--font-mono)' }}>{offer.type}</span>
                                                </div>
                                            </div>
                                        </td>
                                        <td>
                                            <span className="px-3 py-1 text-xs font-semibold rounded bg-[rgba(248,113,113,0.12)] text-[var(--color-negative)] border border-[rgba(248,113,113,0.2)]" style={{ fontFamily: 'var(--font-mono)' }}>Building 1</span>
                                        </td>
                                        <td style={{ textAlign: 'center' }}>
                                            <span className="text-white font-semibold" style={{ fontFamily: 'var(--font-mono)' }}>
                                                {offer.amount.toFixed(1)} <span className="text-[var(--color-text-dim)] font-normal text-xs">kWh</span>
                                            </span>
                                        </td>
                                        <td style={{ textAlign: 'center' }}>
                                            <span className={`font-bold ${offer.price > 0.25 ? 'text-[var(--color-negative)]' : offer.price > 0.15 ? 'text-[var(--color-warning)]' : 'text-[var(--color-positive)]'}`} style={{ fontFamily: 'var(--font-mono)' }}>
                                                ${offer.price.toFixed(2)}<span className="text-[var(--color-text-muted)] font-normal text-xs">/kWh</span>
                                            </span>
                                        </td>
                                        <td style={{ textAlign: 'center' }}>
                                            {isProcessing ? (
                                                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-accent)] animate-pulse">
                                                    <Loader2 size={12} className="animate-spin" /> In Queue...
                                                </span>
                                            ) : isCompleted ? (
                                                <span className="inline-flex items-center gap-1.5 text-xs font-medium text-[var(--color-positive)]">
                                                    <CheckCircle2 size={12} /> Completed
                                                </span>
                                            ) : (
                                                <span className="text-xs text-[var(--color-text-muted)]">Available</span>
                                            )}
                                        </td>
                                        <td style={{ textAlign: 'center' }}>
                                            <button
                                                onClick={() => handleBuyClick(offer)}
                                                disabled={status !== 'idle' || offer.amount <= 0 || (requiredEnergy <= 0 && offer.amount > 0)}
                                                className={`px-4 py-1.5 text-xs font-bold rounded-md transition-all duration-200 ${isCompleted ? 'bg-transparent text-[var(--color-text-muted)] border border-[var(--color-border)] cursor-default opacity-50' : isProcessing ? 'bg-[var(--color-card)] border border-[var(--color-accent)] text-[var(--color-accent)] cursor-wait opacity-80' : (offer.amount <= 0 || requiredEnergy <= 0) ? 'bg-transparent text-[var(--color-text-muted)] border border-[var(--color-border)] cursor-not-allowed opacity-30' : 'bg-[var(--color-accent)] text-black hover:bg-[#33e0ff] active:scale-95'}`}
                                            >
                                                {isCompleted ? 'Purchased' : (offer.amount <= 0 ? 'Sold Out' : 'Buy Energy')}
                                            </button>
                                        </td>
                                    </tr>
                                );
                            })}
                        </tbody>
                    </table>
                </div>
            </div>

            {/* BUY MODAL */}
            {showModal && selectedOffer && (
                <div className="fixed inset-0 bg-black/50 backdrop-blur-sm flex items-center justify-center z-50 animate-enter">
                    <div className="bg-[var(--color-card)] border border-[var(--color-border)] rounded-lg p-6 w-full max-w-md shadow-2xl transform transition-all scale-100">
                        <div className="flex justify-between items-start mb-4">
                            <div>
                                <h3 className="text-lg font-bold text-white">Confirm Purchase</h3>
                                <p className="text-xs text-[var(--color-text-muted)]">Buying from {selectedOffer.source}</p>
                            </div>
                            <button onClick={() => setShowModal(false)} className="text-[var(--color-text-muted)] hover:text-white transition-colors">✕</button>
                        </div>

                        <div className="space-y-4">
                            <div className="bg-[var(--color-bg)] p-3 rounded-md border border-[var(--color-border)] flex justify-between items-center">
                                <span className="text-sm text-[var(--color-text-muted)]">Available Energy</span>
                                <span className="font-mono font-bold text-[var(--color-accent)]">{selectedOffer.amount.toFixed(1)} kWh</span>
                            </div>

                            <div>
                                <label className="block text-xs font-semibold text-[var(--color-text-muted)] uppercase tracking-wider mb-1.5">Amount to Buy (kWh)</label>
                                <input
                                    type="number"
                                    value={buyAmount}
                                    onChange={(e) => setBuyAmount(e.target.value)}
                                    placeholder={`Max ${selectedOffer.amount}`}
                                    className="w-full bg-[var(--color-surface)] border border-[var(--color-border)] rounded px-3 py-2 text-white placeholder-[var(--color-text-dim)] focus:outline-none focus:border-[var(--color-accent)] transition-colors"
                                />
                            </div>

                            <p className="text-xs text-[var(--color-text-muted)] italic">
                                * Transaction will be processed via MetaMask. Gas fees apply.
                            </p>

                            <div className="flex gap-3 pt-2">
                                <button
                                    onClick={() => setShowModal(false)}
                                    className="flex-1 py-2 text-sm font-semibold text-[var(--color-text-muted)] bg-[var(--color-surface)] border border-[var(--color-border)] rounded hover:bg-[var(--color-border)] transition-colors"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleConfirmBuy}
                                    className="flex-1 py-2 text-sm font-bold text-black bg-[var(--color-accent)] rounded hover:bg-[#33e0ff] transition-colors shadow-[0_0_15px_rgba(0,229,255,0.3)]"
                                >
                                    Confirm Buy
                                </button>
                            </div>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};

export default Trading;
