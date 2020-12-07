require('dotenv').config()
const _ = require('lodash');
const http = require('http')
const fs = require('fs')
const express = require('express')
const Binance = require('node-binance-api')
const binance = new Binance().options({
  APIKEY: process.env.BINANCE_API_KEY,
  APISECRET: process.env.BINANCE_API_SECRET
});

const config = require('./config_x50.json');
const params = _.find(config.param, (param) => {
  return param.SYMBOL === process.env.SYMBOL
});

const INIT_FUND = params.INIT_FUND
const TIME_FRAME = params.TIME_FRAME
const REFER_FRAME = params.REFER_FRAME
const LEVERAGE = params.LEVERAGE
const LONG_CANDLE = params.LONG_CANDLE
const STEPS = params.STEPS //Price
const STEPS_AMOUNT = params.STEPS_AMOUNT // Quantity(%)
const PNL_STOPLOSS = params.PNL_STOPLOSS    // loss 26%
const POSITION_STEPS = params.POSITION_STEPS // trung bình giá nếu lỗ x%
const SYMBOL = params.SYMBOL
const ASSET = params.ASSET
const TOKEN = params.TOKEN
const TOKEN_DECIMAL = params.TOKEN_DECIMAL
const ISLONG = params.ISLONG
const ISSHORT = params.ISSHORT
const FLOORPRICE = params.FLOORPRICE
const CEILPRICE = params.CEILPRICE
const PNL_TAKEPROFIT = params.PNL_TAKEPROFIT
const AMOUNT_PER_ORDER = params.AMOUNT_PER_ORDER

var currentDateTime = new Date();
const log_File = currentDateTime.getFullYear() + "-" + (currentDateTime.getMonth()+1) + "-" + currentDateTime.getDate() + "-" + currentDateTime.getTime()
var  long = true
var  short = true
var stopLossCount = 0
var takeprofitCount = 0


function PNL_TAKE_PROFIT(amount) {
  return 20
}

function GET_STEP(candles) {
  var lastCandle = candles[candles.length - 2]
  var currentCandle = candles[candles.length - 1]
  var high = lastCandle.high
  var low = lastCandle.low

  if (lastCandle.high < currentCandle.high) {
    high = currentCandle.high
  }

  if (lastCandle.low > currentCandle.low) {
    low = currentCandle.low
  }

  var change = high - low
  var amplitude = (change / high) * 100
  var step = change * 0.7

  return step
  // if (amplitude <= 0.8) return 0
  // else if (amplitude <= 1.5) return 1
  // else if (amplitude <= 2) return 2
  // return 3
}

let sleep = (time) => new Promise((resolve) => setTimeout(resolve, time))

async function balance() {
  var b = (await binance.futuresBalance()).find(e => e.asset === ASSET)
  b.balance = parseFloat(b.balance)
  b.crossWalletBalance = parseFloat(b.crossWalletBalance)
  b.crossUnPnl = parseFloat(b.crossUnPnl)
  b.availableBalance = parseFloat(b.availableBalance)
  b.maxWithdrawAmount = parseFloat(b.maxWithdrawAmount)

  return b
}


async function openOrders() {
  return await binance.futuresOpenOrders(SYMBOL)
}

async function cancelAllOpenOrder() {
  console.log('\n> CANCEL ALL OPEN ORDER')
  await binance.futuresCancelAll(SYMBOL)
}

async function position() {
  var p = (await binance.futuresPositionRisk()).find(e => e.symbol === SYMBOL)
  if (p && p.entryPrice != 0) {
    p.positionAmt = parseFloat(p.positionAmt)
    p.entryPrice = parseFloat(p.entryPrice)
    p.markPrice = parseFloat(p.markPrice)
    p.unRealizedProfit = parseFloat(p.unRealizedProfit)
    p.liquidationPrice = parseFloat(p.liquidationPrice)
    p.leverage = parseFloat(p.leverage)
    p.side = p.positionAmt > 0 ? 'LONG' : 'SHORT'
    p.positionAmt = Math.abs(parseFloat(p.positionAmt))

    return p
  }

  return null
}

async function closePosition(p) {
  if (p && p.entryPrice != 0) {
    console.log('\n> CLOSE POSITION')
    if (p.side == 'LONG') {
      await binance.futuresMarketSell(SYMBOL, p.positionAmt)
    }
    else {
      await binance.futuresMarketBuy(SYMBOL, p.positionAmt)
    }
  }
}

async function candle(t) {
  var ticks = await binance.futuresCandles(SYMBOL, t, {limit: 100})
  return ticks.map(e => {
    let [
      time, 
      open, 
      high, 
      low, 
      close, 
      volume, 
      closeTime, 
      assetVolume, 
      trades, 
      buyBaseVolume, 
      buyAssetVolume
    ] = e;
    return {
      time, 
      open: parseFloat(open),
      high: parseFloat(high),
      low: parseFloat(low),
      close: parseFloat(close),
      average: ((parseFloat(low) + parseFloat(high)) / 2),
      volume: parseFloat(volume),
      closeTime, 
      assetVolume: parseFloat(assetVolume), 
      trades, 
      buyBaseVolume: parseFloat(buyBaseVolume), 
      buyAssetVolume: parseFloat(buyAssetVolume)
    }
  })
}

async function createOrder(side, step, currentPrice, amount, laverage) {
  if (side === 'LONG') {
    var orderPrice = (currentPrice - step).toFixed(2)
    var quantity = parseFloat((laverage * amount / orderPrice).toFixed(TOKEN_DECIMAL))
    var o = await binance.futuresBuy(SYMBOL, quantity, orderPrice)
    if (o.orderId) {
      console.log(`LONG  | ${step.toFixed(4)} | ${amount} > ${quantity} @${orderPrice} / ${currentPrice.toFixed(4)}`)
    }
    else {
      console.log(`\nERROR > LONG  | ${step.toFixed(4)} | ${amount} > ${quantity} @${orderPrice} / ${currentPrice.toFixed(4)}`)
      console.log(o.msg)
      console.log('\n')
    }
  }
  else {
    var orderPrice = (currentPrice + step).toFixed(2)
    var quantity = parseFloat((laverage * amount / orderPrice).toFixed(TOKEN_DECIMAL))
    var o = await binance.futuresSell(SYMBOL, quantity, orderPrice)
    if (o.orderId) {
      console.log(`SHORT | ${step.toFixed(4)} | ${amount}: ${quantity} @${orderPrice} / ${currentPrice.toFixed(4)}`)
    }
    else {
      console.log(`\nERROR > SHORT | ${step.toFixed(4)} | ${amount}: ${quantity} @${orderPrice} / ${currentPrice.toFixed(4)}`)
      console.log(o.msg)
      console.log('\n')
    }
  }
}

(async function() {

  var isRunning = false
  var lastTimeOrder = 0
  var lastPosition = null
  
  var web_canl, web_p, web_bal, web_ords, web_trades;
  if (params.DASHBOARD === 'true') {
    const app = express();
  
    app.get('/', (req, res) => {
      if (req.query['tung-do9tr4de-1243']) {
        res.status(200).send(fs.readFileSync('./index.html', 'utf8'))
      }
      else {
        res.status(200).send('Hi :)')
      }
    })
  
    app.get('/data', (req, res) => {
      if (req.query['d4ta-tung-do9tr4de-1243']) {
        res.json({
          candles: web_canl,
          trades: web_trades,
          position: web_p,
          balance: web_bal,
          orders: web_ords
        })
      }
      else {
        res.status(200).send('Hi :)')
      }
    })
  
    http.createServer(app).listen(process.env.PORT || 8889, async (err) => {
      console.log('server started', process.env.PORT || 8889)
    });
  }
  
  async function run() {
    if (isRunning) return
    isRunning = true
    var [canl, p, bal, ords, trades, referCandles] = await Promise.all([
      candle(TIME_FRAME),
      position(),
      balance(),
      openOrders(),
      binance.futuresUserTrades( SYMBOL ),
      candle(REFER_FRAME),
    ])

    web_canl = canl
    web_p = p
    web_ords = ords
    web_bal = bal
    web_trades = trades
    
    if (bal.balance < INIT_FUND * 0.9) {
      return;
    }
    
    var percentPnL = 0
    var l = canl[canl.length - 2]
    var nc = canl[canl.length - 1]

    console.log('\n-----------------------\n')
    console.log(`${new Date(nc.time).toLocaleTimeString()} < ${new Date().toLocaleTimeString()} < ${new Date(nc.closeTime).toLocaleTimeString()}`)
    if (p) {
      lastTimeOrder = 0
      percentPnL = parseFloat((p.unRealizedProfit / (p.entryPrice * p.positionAmt / LEVERAGE)) * 100).toFixed(4)
      var LossPercent = (p.unRealizedProfit / INIT_FUND) * 100 // %Loss/INIT_FUND
      if (percentPnL > PNL_TAKEPROFIT || LossPercent < PNL_STOPLOSS) {
        await closePosition(p)
        if (ords.length > 0) {
          await cancelAllOpenOrder()
        }
        lastPosition = null
        if (LossPercent < PNL_STOPLOSS) {
          stopLossCount = stopLossCount + 1
          await fs.appendFileSync('./logs/'+SYMBOL+'_PnL_x50_'+log_File+'.txt','StopLoss('+stopLossCount+') '+ p.side+' at: '+ new Date().toLocaleTimeString()+ "\n")
          await sleep(8 * 60 * 1000)
        }else{
          takeprofitCount = takeprofitCount + 1
          await fs.appendFileSync('./logs/'+SYMBOL+'_PnL_x50_'+log_File+'.txt','TakeProfit('+takeprofitCount+') '+ p.side+' at: '+ new Date().toLocaleTimeString()+ "\n")
          if (p.side === 'LONG') {
            long = false
          }
          else if (p.side === 'SHORT') {
            short = false
          }
          await sleep(30000)
        }
      }
       else if (!lastPosition || lastPosition.positionAmt !== p.positionAmt || ords.length == 0) {
          if (ords.length > 0) {
            await cancelAllOpenOrder()
            await sleep(2000)
          }         
       }
    }
    else if (l.time > lastTimeOrder || ords.length === 0) {
      if (ords.length > 0) {
        await cancelAllOpenOrder()
        await sleep(1000)
      }
      lastTimeOrder = l.time

      var step = 0
      step = await GET_STEP(referCandles)

      if (nc.close < FLOORPRICE) {
        if (ISLONG && long) {
          //for (var i = 0; i < STEPS.length; i++) {
            //let amount = (INIT_FUND / 100) * AMOUNT_PER_ORDER
            let amount = AMOUNT_PER_ORDER
            if (bal.availableBalance > amount) {
              await createOrder('LONG', step, nc.close, amount, LEVERAGE)
              await sleep(500)
            }
          //}
        }
      }
      if (nc.close > CEILPRICE) {
        if (ISSHORT && short) {
          //for (var i = 0; i < STEPS.length; i++) {
            //let amount = (INIT_FUND / 100) * AMOUNT_PER_ORDER
            let amount = AMOUNT_PER_ORDER
            if (bal.availableBalance > amount) {
              await createOrder('SHORT', step, nc.close, amount, LEVERAGE)
              await sleep(500)
            }
          //}
        }
      }
      long = true
      short = true
      await sleep(2000)
    }

    ords = await openOrders()
    
    console.log(`\nBAL       :  ${bal.availableBalance.toFixed(4)} USDT | ${bal.balance.toFixed(4)} USDT`)

    if (p) {
      console.log(`\nPOS       :  ${p.side}`)
      console.log(`             ${Math.abs(p.positionAmt.toFixed(4))} ${TOKEN}`)
      console.log(`             ${p.entryPrice.toFixed(4)} USD`)
      console.log(`MARK PRICE:  ${nc.close}`) //→ 
      console.log(`LIQUI     :  ${p.liquidationPrice.toFixed(4)} USD`)
      console.log(`MARGI     :  ${(p.entryPrice * p.positionAmt / LEVERAGE).toFixed(4)} USD`)
      
      console.log(`PnL       :  ${p.unRealizedProfit.toFixed(4)} USD (${percentPnL})%`)
    }

    if (ords.length > 0) {
      console.log('\nORDER:')
      var shortOrders = ords
        .filter(e => e.side === 'SELL')
        .sort((a, b) => {
          return parseFloat(b.price) - parseFloat(a.price)
        })
        .map(e => `${parseFloat(e.price)} → ${parseFloat(e.origQty).toFixed(4)}`)
      var longOrders = ords
        .filter(e => e.side === 'BUY')
        .sort((a, b) => {
          return parseFloat(b.price) - parseFloat(a.price)
        })
        .map(e => `${parseFloat(e.price)} → ${parseFloat(e.origQty).toFixed(4)}`)
      
      shortOrders.forEach(e => {
        console.log(`▼ ${e}`)
      })
      console.log(`  ${nc.close}`) //→ 
      longOrders.forEach(e => {
        console.log(`▲ ${e}`)
      })
    }
    isRunning = false
  }
  setInterval(async () => {
    try {
      await run()
    }
    catch (ex) {
      isRunning = false
      console.log('Catch ERROR')
      console.log(ex.toString())
      console.log(ex.stack)
    }
  }, 5000)
})()