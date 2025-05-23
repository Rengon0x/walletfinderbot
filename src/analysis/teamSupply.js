// src/analysis/teamSupply.js
// Fixed to properly categorize team wallets and remove teambot detection

const { getSolanaApi } = require('../integrations/solanaApi');
const { checkInactivityPeriod } = require('../tools/inactivityPeriod');
const { getHolders } = require('../tools/getHolders');
const { analyzeFunding } = require('../tools/fundingAnalyzer'); 
const BigNumber = require('bignumber.js');
const logger = require('../utils/logger');

// Configuration
BigNumber.config({ DECIMAL_PLACES: 18, ROUNDING_MODE: BigNumber.ROUND_DOWN });

// Constants
const KNOWN_LP_POOLS = new Set([
    "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1",
    "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P",
    "MoonCVVNZFSYkqNXP6bxHLPL6QQJiMagDL3qcqUQTrG",
    "LBUZKhRxPF3XUpBCjp4YzTKgLccjZhTSDM9YuVaPwxo",
    "5quBtoiQqxF9Jv6KYKctB59NT3gtJD2Y65kdnB1Uev3h",
    "675kPX9MHTjS2zt1qfr1NYHuzeLXfQM9H24wFSUt1Mp8",
    "CPMMoo8L3F4NbTegBCKVNunggL7H1ZpdTHKxQB5qKP1C",
    "GpMZbSM2GgvTKHJirzeGfMFoaZ8UR2X7F4v8vHTvxFbL",
]);

const FRESH_WALLET_THRESHOLD = 100;
const SUPPLY_THRESHOLD = new BigNumber('0.001'); // 0.1%
const WALLET_ANALYSIS_TIMEOUT = 30000; // Increased to 30 seconds per wallet
const BATCH_SIZE = 5; 
const BATCH_DELAY = 200; 

// Define team wallet categories - removed Teambot
const TEAM_WALLET_CATEGORIES = new Set([
    'Fresh', 
    'Inactive', 
    'No Token', 
    'No ATA Transaction'
]);

/**
 * Checks if a wallet is considered a team wallet based on its category
 * @param {string} category - Wallet category
 * @returns {boolean} True if it's a team wallet category
 */
function isTeamWalletCategory(category) {
    return TEAM_WALLET_CATEGORIES.has(category);
}

/**
 * Analyzes the team supply for a given token
 */
async function analyzeTeamSupply(tokenAddress, mainContext = 'default', cancellationToken = null) {
    const operationId = Math.random().toString(36).substring(2, 8);
    logger.info(`Starting team supply analysis for ${tokenAddress} (ID: ${operationId})`);

    const progress = {
        startTime: Date.now(),
        steps: []
    };

    // Helper function to log steps with timestamps
    const logStep = (step) => {
        const now = Date.now();
        progress.steps.push({
            step,
            timestamp: now,
            elapsed: now - progress.startTime
        });
        logger.debug(`[${operationId}] ${step} (${now - progress.startTime}ms elapsed)`);
    };

    // Helper to check for cancellation
    const checkCancellation = () => {
        if (cancellationToken && cancellationToken.isCancelled()) {
            logStep('Operation cancelled by user');
            throw new Error('Analysis cancelled by user');
        }
    };

    try {
        // 1. Fetch token info
        checkCancellation();
        logStep('Fetching token info from Helius');
        const solanaApi = getSolanaApi();
        const assetInfo = await solanaApi.getAsset(tokenAddress, mainContext, 'analyzeTeamSupply');
        
        if (!assetInfo) {
            throw new Error("No token info found");
        }

        const tokenInfo = {
            total_supply: assetInfo.supply.total, 
            symbol: assetInfo.symbol,
            name: assetInfo.name,
            decimals: assetInfo.decimals,
            address: tokenAddress
        };

        logStep(`Token info received: ${tokenInfo.symbol}`);

        // 2. Get holders
        checkCancellation();
        logStep('Fetching token holders');
        const allHolders = await getHolders(tokenAddress, mainContext, 'getHolders');
        logStep(`Found ${allHolders.length} total holders`);
        
        // 3. Filter significant holders
        checkCancellation();
        const significantHolders = allHolders.filter(holder => {
            // Skip known liquidity pools
            if (KNOWN_LP_POOLS.has(holder.address)) {
                return false;
            }

            // Only include holders with significant balances
            const rawBalance = new BigNumber(holder.balance);
            const percentage = rawBalance.dividedBy(new BigNumber(tokenInfo.total_supply));
            return percentage.isGreaterThanOrEqualTo(SUPPLY_THRESHOLD);
        });
    
        logStep(`Filtered ${significantHolders.length} significant holders (threshold: ${SUPPLY_THRESHOLD.multipliedBy(100).toString()}%)`);
    
        // 4. Analyze wallets
        checkCancellation();
        logStep('Analyzing wallets');
        const analyzedWallets = await analyzeWalletsWithTimeout(
            significantHolders, 
            tokenAddress, 
            mainContext, 
            tokenInfo, 
            operationId, 
            cancellationToken
        );
        logStep(`Analyzed ${analyzedWallets.length} wallets`);
        
        // 5. Filter team wallets - FIXED: Only include wallets with team categories
        checkCancellation();
        const teamWallets = analyzedWallets
            .filter(w => isTeamWalletCategory(w.category))
            .map(w => ({
                address: w.address,
                balance: w.balance.toString(),
                percentage: new BigNumber(w.balance)
                    .dividedBy(new BigNumber(tokenInfo.total_supply))
                    .multipliedBy(100)
                    .toNumber(),
                category: w.category,
                funderAddress: w.funderAddress || null,
                fundingDetails: w.fundingDetails || null
            }));

        logStep(`Filtered ${teamWallets.length} team wallets`);
        
        // 6. Calculate supply - FIXED: Only count wallets with team categories
        checkCancellation();
        const teamSupplyHeld = analyzedWallets
            .filter(w => isTeamWalletCategory(w.category))
            .reduce((total, wallet) => {
                return total.plus(new BigNumber(wallet.balance));
            }, new BigNumber(0));
        
        const totalSupplyControlled = teamSupplyHeld
            .dividedBy(new BigNumber(tokenInfo.total_supply))
            .multipliedBy(100)
            .toNumber();

        logStep(`Team supply controlled: ${totalSupplyControlled.toFixed(2)}%`);

        // Create result objects
        return {
            scanData: {
                tokenInfo: {
                    totalSupply: tokenInfo.total_supply,
                    symbol: tokenInfo.symbol,
                    name: tokenInfo.name,
                    decimals: tokenInfo.decimals,
                    address: tokenAddress
                },
                analyzedWallets: analyzedWallets,  // Include all analyzed wallets
                teamWallets,
                totalSupplyControlled,
                tokenAddress
            },
            trackingInfo: {
                tokenAddress,
                tokenSymbol: tokenInfo.symbol,
                totalSupply: tokenInfo.total_supply,
                decimals: tokenInfo.decimals,
                totalSupplyControlled,
                teamWallets,
                allWalletsDetails: analyzedWallets  // Include all analyzed wallets
            }
        };

    } catch (error) {
        if (cancellationToken && cancellationToken.isCancelled()) {
            logger.warn(`[${operationId}] Analysis cancelled for ${tokenAddress}`);
            throw new Error('Analysis cancelled by user');
        }
        
        logger.error(`[${operationId}] Error in analyzeTeamSupply:`, error);
        throw error;
    }
}

/**
 * Analyze wallets with timeout and cancellation support
 */
async function analyzeWalletsWithTimeout(wallets, tokenAddress, mainContext, tokenInfo, operationId, cancellationToken) {
    // Log progress every 10% of wallets
    const progressStep = Math.max(1, Math.ceil(wallets.length / 10));
    let lastProgressLog = 0;
    
    // Analyze a single wallet with timeout
    const analyzeWalletWithTimeout = async (wallet, index) => {
        // Check for cancellation
        if (cancellationToken && cancellationToken.isCancelled()) {
            throw new Error('Analysis cancelled by user');
        }
        
        // Log progress periodically
        if (index >= lastProgressLog + progressStep) {
            logger.info(`[${operationId}] Progress: analyzed ${index}/${wallets.length} wallets (${Math.round(index/wallets.length*100)}%)`);
            lastProgressLog = index;
        }
        
        try {
            // Use Promise.race with a timeout
            return await Promise.race([
                analyzeWallet(wallet, tokenAddress, mainContext, tokenInfo, operationId, cancellationToken),
                new Promise((_, reject) => 
                    setTimeout(() => reject(new Error(`Wallet analysis timeout for ${wallet.address.slice(0, 8)}...`)), 
                    WALLET_ANALYSIS_TIMEOUT)
                )
            ]);
        } catch (error) {
            // If the wallet analysis fails or times out, return the wallet with Error category
            logger.warn(`[${operationId}] Wallet analysis failed for ${wallet.address.slice(0, 8)}...: ${error.message}`);
            return {
                ...wallet,
                category: 'Error',
                error: error.message
            };
        }
    };

    // Process wallets in smaller batches with breaks between batches
    const analyzedWallets = [];
    for (let i = 0; i < wallets.length; i += BATCH_SIZE) {
        // Check for cancellation before each batch
        if (cancellationToken && cancellationToken.isCancelled()) {
            logger.warn(`[${operationId}] Analysis cancelled during batch processing`);
            throw new Error('Analysis cancelled by user');
        }
        
        const batch = wallets.slice(i, i + BATCH_SIZE);
        logger.debug(`[${operationId}] Processing batch ${Math.floor(i/BATCH_SIZE) + 1}/${Math.ceil(wallets.length/BATCH_SIZE)}`);
        
        // Process each wallet in the batch
        const batchResults = await Promise.all(
            batch.map((wallet, batchIndex) => 
                analyzeWalletWithTimeout(wallet, i + batchIndex)
            )
        );
        analyzedWallets.push(...batchResults);

        // Small break between batches to avoid rate limiting
        if (i + BATCH_SIZE < wallets.length) {
            await new Promise(resolve => setTimeout(resolve, BATCH_DELAY));
        }
    }

    logger.info(`[${operationId}] Completed analysis of all ${wallets.length} wallets`);
    return analyzedWallets;
}

/**
 * Analyze a single wallet
 */
async function analyzeWallet(wallet, tokenAddress, mainContext, tokenInfo, operationId, cancellationToken) {
    // Check for cancellation
    if (cancellationToken && cancellationToken.isCancelled()) {
        throw new Error('Analysis cancelled by user');
    }
    
    try {
        // Start with "Normal" category (non-team)
        let category = "Normal";  
        let daysSinceLastActivity = null;

        // Fast track for optimization: if a wallet has over 1000 transactions, skip detailed analysis
        if (await hasExcessiveTransactions(wallet.address, mainContext)) {
            return {
                ...wallet,
                category,
                daysSinceLastActivity: null,
                funderAddress: null,
                fundingDetails: null
            };
        }

        // First try to identify if it's a fresh wallet (this is faster)
        const isFresh = await isFreshWallet(wallet.address, mainContext, 'isFreshWallet');
        if (isFresh) {
            category = 'Fresh';
        } else {
            try {
                // Check for cancellation before expensive operation
                if (cancellationToken && cancellationToken.isCancelled()) {
                    throw new Error('Analysis cancelled by user');
                }
                
                // Only run inactivity period check if the wallet isn't fresh
                const inactivityCheck = await checkInactivityPeriod(wallet.address, tokenAddress, mainContext, 'checkInactivity');
                
                // Handle the different inactivity check results
                if (inactivityCheck) {
                    if (inactivityCheck.category === 'No Token') {
                        category = 'No Token';
                    } else if (inactivityCheck.category === 'No ATA Transaction') {
                        category = 'No ATA Transaction';
                    } else if (inactivityCheck.isInactive) {
                        category = 'Inactive';
                        daysSinceLastActivity = inactivityCheck.daysSinceLastActivity;
                    }
                    // Removed teambot check entirely
                }
            } catch (inactivityError) {
                // Don't log every inactivity error - just continue with category as Normal
                // Only log significant errors so we don't flood logs
                if (inactivityError.message && !inactivityError.message.includes('No Token')) {
                    logger.debug(`[${operationId}] Inactivity check error for ${wallet.address.slice(0, 8)}...: ${inactivityError.message}`);
                }
                // Don't change category here - keep it as Normal
            }
        }
        
        // Check for cancellation before funding analysis
        if (cancellationToken && cancellationToken.isCancelled()) {
            throw new Error('Analysis cancelled by user');
        }
        
        // Analyze funding source - this helps identify team wallets
        try {
            const fundingResult = await analyzeFunding(
                [{address: wallet.address}], 
                mainContext, 
                'analyzeFunding'
            );
            
            // Only update if funding analysis returned results
            if (fundingResult && fundingResult.length > 0) {
                const fundingInfo = fundingResult[0];
                
                return {
                    ...wallet,
                    category,
                    daysSinceLastActivity,
                    funderAddress: fundingInfo?.funderAddress || null,
                    fundingDetails: fundingInfo?.fundingDetails || null
                };
            }
        } catch (fundingError) {
            // Only log significant funding errors
            logger.debug(`[${operationId}] Funding analysis error for ${wallet.address.slice(0, 8)}...: ${fundingError.message}`);
        }
        
        // Return wallet data even if funding analysis failed
        return {
            ...wallet,
            category,
            daysSinceLastActivity,
            funderAddress: null,
            fundingDetails: null
        };
        
    } catch (error) {
        // If analysis was cancelled, propagate that error
        if (error.message.includes('cancelled')) {
            throw error;
        }
        
        // For all other errors, return wallet with Error category
        logger.error(`[${operationId}] Error analyzing wallet ${wallet.address.slice(0, 8)}...:`, error);
        return {
            ...wallet,
            category: 'Error',
            error: error.message
        };
    }
}

/**
 * Check if a wallet has excessive transactions (optimization)
 */
async function hasExcessiveTransactions(address, mainContext) {
    try {
        const solanaApi = getSolanaApi();
        const signatures = await solanaApi.getSignaturesForAddress(
            address, 
            { limit: 1001 }, // Just over 1000 to check if we hit the threshold
            mainContext,
            'checkTransactionCount'
        );
        
        return signatures.length >= 1000;
    } catch (error) {
        // Don't log every error here
        return false; // Default to false if we can't determine
    }
}

/**
 * Check if a wallet is a fresh wallet
 */
async function isFreshWallet(address, mainContext, subContext) {
    try {
        const solanaApi = getSolanaApi();
        
        // Get transactions and check if count is below threshold
        const initialSignatures = await solanaApi.getSignaturesForAddress(
            address, 
            { limit: FRESH_WALLET_THRESHOLD + 1 }, // +1 to check if exceeding threshold
            mainContext,
            subContext
        );
        
        // Check if the number of transactions is below threshold
        return initialSignatures.length < FRESH_WALLET_THRESHOLD;
    } catch (error) {
        return false;
    }
}

module.exports = {
    analyzeTeamSupply,
    isTeamWalletCategory // Exported for testing
};