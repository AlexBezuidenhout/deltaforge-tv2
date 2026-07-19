# Make George Trade Live

Currently, George is hardcoded as a "Paper Only" split-test bot. You've requested to make George trade live alongside the Main Bot when Paper Trading is disabled.

## ⚠️ Critical Architectural Risk (User Review Required)

Polymarket manages positions at the **wallet level**. If both the Main Bot and George use the **same** Polymarket wallet, they will intermingle tokens. 

Because George holds trades to resolution but Main Bot can exit early, here is the critical danger:
- **Opposite Trades**: If Main Bot buys 10 `YES` tokens, and George buys 5 `NO` tokens on the same market, Polymarket automatically offsets them. Your wallet will only have 5 `YES` tokens.
- **The Failure**: If the Main Bot later tries to sell its 10 `YES` tokens to lock in profit or cut a loss, the sell order will **FAIL** because the wallet only holds 5 `YES` tokens. The Main Bot will be trapped in the trade!

### Open Question

How would you like to handle this?
1. **Option A (Safest)**: Add fields for a *Second Wallet* specifically for George (e.g., `George Private Key`, `George Wallet Address`). This guarantees no token conflicts.
2. **Option B (Shared Wallet + Conflict Guard)**: Use the same wallet, but I will add code to prevent George from entering a trade if the Main Bot already holds an opposite position on that same market.
3. **Option C (YOLO)**: Just use the same wallet and accept the risk of token offset failures.

## Proposed Changes (Assuming Option B for now, pending your answer)

### 1. Update George's Initialization (`src/bot/GeorgeBotInstance.js`)
- [MODIFY] `src/bot/GeorgeBotInstance.js`:
  - When `!this.settings.paper_trading`, initialize `PolymarketFeed` with the user's actual API keys and private key instead of `null`.

### 2. Update George's Execution Logic
- [MODIFY] `src/bot/GeorgeBotInstance.js`:
  - In `_executeTrade`, check if we are live. 
  - If live, call `this.polymarket.placeOrder()` to execute a FAK Market Buy.
  - Save the actual `filled_price` and `token_id` to the `george_trades` table.
  - (If Option B) Add a check against `trades` table to ensure MainBot doesn't have an opposite position.

### 3. Update George's Resolution Logic
- [MODIFY] `src/bot/GeorgeBotInstance.js`:
  - In `_manageOpenPositions`, calculate PnL based on the actual live entry price. (Since George holds to resolution, we don't need to send sell orders; Polymarket auto-redeems winning tokens).

## Verification Plan
1. Ensure the UI can still save settings.
2. Verify George's `_executeTrade` correctly routes to Polymarket only when live.
