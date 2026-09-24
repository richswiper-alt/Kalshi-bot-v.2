# BIGSWIPE

This is a keyless ETH paper predictor. It uses public market data and never places orders.

## Start it

Open the VS Code terminal in this folder and run:

```bash
bash START_BIGSWIPE_FINAL.sh
```

It prints a new paper call every minute. Press `Ctrl+C` to stop.

## One call only

```bash
node BIGSWIPE_FINAL.js --once
```

The output includes the signal, RSI, EMA, learned accuracy, paper entry, target exit, stop, estimated profit/loss, and risk/reward.

No Telegram, email, SMS, notes, API keys, or private keys are required.
