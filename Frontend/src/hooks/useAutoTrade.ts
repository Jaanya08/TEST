import { useState, useEffect, useRef, useCallback } from 'react';
import { ethers } from 'ethers';
import { fetchAutoTradeCheck, postAutoTradeExecute } from '../services/api';
import type { AutoTradeItem } from '../services/api';

/* ─── Contract config (same as Trading.tsx) ─── */
const CONTRACT_ADDRESS = '0xf3bab00B2cEF39f27838F1dDec3CA52db13Ee9eA';
const CONTRACT_ABI = [
    {
        inputs: [
            { internalType: 'address', name: '_seller', type: 'address' },
            { internalType: 'uint256', name: '_energy', type: 'uint256' },
        ],
        name: 'buyFromBuilding',
        outputs: [],
        stateMutability: 'payable',
        type: 'function',
    },
];

/* ─── Types ─── */
export type AutoTradeStatus =
    | 'idle'
    | 'paused'
    | 'checking'
    | 'trade-detected'
    | 'awaiting-wallet'
    | 'confirming'
    | 'completed'
    | 'error'
    | 'cooldown';

export interface AutoTradeLogEntry {
    id: string;
    timestamp: Date;
    buyerName: string;
    sellerName: string;
    energyKwh: number;
    ethSpent: string;
    txHash: string;
    status: 'success' | 'failed';
    error?: string;
}

export interface AutoTradeStats {
    totalTrades: number;
    totalEthSpent: number;
    totalEnergyAcquired: number;
}

const POLL_INTERVAL = 5000;     // 5 seconds
const COOLDOWN_DURATION = 30000; // 30 seconds after each trade

export function useAutoTrade() {
    const [enabled, setEnabled] = useState(false);
    const [status, setStatus] = useState<AutoTradeStatus>('paused');
    const [log, setLog] = useState<AutoTradeLogEntry[]>([]);
    const [stats, setStats] = useState<AutoTradeStats>({
        totalTrades: 0,
        totalEthSpent: 0,
        totalEnergyAcquired: 0,
    });
    const [pendingTrade, setPendingTrade] = useState<AutoTradeItem | null>(null);
    const [errorMessage, setErrorMessage] = useState<string | null>(null);

    const cooldownUntil = useRef<number>(0);
    const isBusy = useRef(false);
    const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);

    /* ─── Execute a single trade on-chain ─── */
    const executeTrade = useCallback(async (trade: AutoTradeItem) => {
        const ethereum = (window as any).ethereum;
        if (!ethereum) {
            setErrorMessage('MetaMask not detected. Please install MetaMask.');
            setStatus('error');
            return;
        }

        try {
            setStatus('awaiting-wallet');
            setPendingTrade(trade);

            // 1. Request account access (this prompts the MetaMask popup if not connected)
            const accounts: string[] = await ethereum.request({ method: 'eth_requestAccounts' });
            if (!accounts || accounts.length === 0) {
                throw new Error('No MetaMask account connected. Please connect your wallet.');
            }

            // 2. Check we are on Sepolia (chainId 0xaa36a7 = 11155111)
            const chainId: string = await ethereum.request({ method: 'eth_chainId' });
            if (chainId !== '0xaa36a7') {
                // Try to switch to Sepolia
                try {
                    await ethereum.request({
                        method: 'wallet_switchEthereumChain',
                        params: [{ chainId: '0xaa36a7' }],
                    });
                } catch (switchErr: any) {
                    throw new Error('Please switch MetaMask to the Sepolia test network.');
                }
            }

            // 3. Create provider + signer
            const provider = new ethers.BrowserProvider(ethereum);
            const signer = await provider.getSigner();
            const contract = new ethers.Contract(CONTRACT_ADDRESS, CONTRACT_ABI, signer);

            setStatus('confirming');

            // 4. Execute the on-chain transaction
            const tx = await contract.buyFromBuilding(
                trade.sellerAddress,
                trade.tradeAmountKwh,
                { value: BigInt(trade.totalPriceWei) }
            );

            await tx.wait();

            // Calculate ETH spent for display
            const ethSpent = ethers.formatEther(BigInt(trade.totalPriceWei));

            // Log to backend
            try {
                await postAutoTradeExecute({
                    buyerBuildingId: trade.buyerBuildingId,
                    sellerBuildingId: trade.sellerBuildingId,
                    energyKwh: trade.tradeAmountKwh,
                    txHash: tx.hash,
                    priceWei: trade.totalPriceWei,
                });
            } catch (err) {
                console.error('Failed to log auto-trade to backend:', err);
            }

            // Update local log
            const entry: AutoTradeLogEntry = {
                id: `at-${Date.now()}`,
                timestamp: new Date(),
                buyerName: trade.buyerName,
                sellerName: trade.sellerName,
                energyKwh: trade.tradeAmountKwh,
                ethSpent,
                txHash: tx.hash,
                status: 'success',
            };

            setLog(prev => [entry, ...prev].slice(0, 50));
            setStats(prev => ({
                totalTrades: prev.totalTrades + 1,
                totalEthSpent: prev.totalEthSpent + parseFloat(ethSpent),
                totalEnergyAcquired: prev.totalEnergyAcquired + trade.tradeAmountKwh,
            }));

            setStatus('completed');
            setPendingTrade(null);

            // Start cooldown
            cooldownUntil.current = Date.now() + COOLDOWN_DURATION;
            setStatus('cooldown');

            setTimeout(() => {
                if (isBusy.current) return;
                setStatus('idle');
            }, COOLDOWN_DURATION);

        } catch (error: any) {
            console.error('Auto-trade transaction failed:', error);

            // Extract a human-readable message
            let errMsg = 'Transaction failed';
            if (error?.code === 'ACTION_REJECTED' || error?.code === 4001) {
                errMsg = 'Transaction rejected by user';
            } else if (error?.reason) {
                errMsg = error.reason;
            } else if (error?.shortMessage) {
                errMsg = error.shortMessage;
            } else if (error?.message) {
                errMsg = error.message.length > 80 ? error.message.slice(0, 80) + '…' : error.message;
            }

            const entry: AutoTradeLogEntry = {
                id: `at-${Date.now()}`,
                timestamp: new Date(),
                buyerName: trade.buyerName,
                sellerName: trade.sellerName,
                energyKwh: trade.tradeAmountKwh,
                ethSpent: '0',
                txHash: '',
                status: 'failed',
                error: errMsg,
            };
            setLog(prev => [entry, ...prev].slice(0, 50));

            setErrorMessage(errMsg);
            setStatus('error');
            setPendingTrade(null);

            // Longer recovery after failure to avoid spamming MetaMask
            const recoveryTime = error?.code === 'ACTION_REJECTED' || error?.code === 4001 ? 60000 : 15000;
            setTimeout(() => {
                setStatus('idle');
                setErrorMessage(null);
            }, recoveryTime);
        } finally {
            isBusy.current = false;
        }
    }, []);

    /* ─── Poll loop ─── */
    const checkAndTrade = useCallback(async () => {
        if (!enabled || isBusy.current) return;
        if (Date.now() < cooldownUntil.current) return;

        try {
            setStatus('checking');
            const result = await fetchAutoTradeCheck();

            if (result.needed && result.trades.length > 0) {
                setStatus('trade-detected');
                isBusy.current = true;

                // Execute the first recommended trade
                await executeTrade(result.trades[0]);
            } else {
                setStatus('idle');
            }
        } catch (err) {
            console.warn('[AutoTrade] Check failed:', err);
            setStatus('idle');
        }
    }, [enabled, executeTrade]);

    /* ─── Start/stop polling ─── */
    useEffect(() => {
        if (enabled) {
            setStatus('idle');
            setErrorMessage(null);
            // Do an immediate check
            checkAndTrade();
            pollRef.current = setInterval(checkAndTrade, POLL_INTERVAL);
        } else {
            setStatus('paused');
            if (pollRef.current) {
                clearInterval(pollRef.current);
                pollRef.current = null;
            }
        }
        return () => {
            if (pollRef.current) {
                clearInterval(pollRef.current);
                pollRef.current = null;
            }
        };
    }, [enabled, checkAndTrade]);

    return {
        enabled,
        setEnabled,
        status,
        log,
        stats,
        pendingTrade,
        errorMessage,
    };
}
