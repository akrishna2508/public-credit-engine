# Global Multi-Asset Heatmap & Returns Strategy Engine

This document outlines the complete backend architecture, quantitative strategy engine, database schema, and Python pipeline code required to build a financial heatmap portal. The system calculates and serves returns across multiple asset classes including options (straddles, volatility risk premium), futures (basis/carry), sovereign bonds, credit default swaps (CDS), and interest rate futures (IRF spreads).

---

## 1. System Architecture & Pipeline Flow

```text
[ Free External APIs ] 
  ├── Yahoo Finance (Indices, Country ETFs, Options Chains, Futures)
  ├── FRED API (Sovereign Yields, Policy Rates, Macro Data, Spreads)
  └── Custom Web Scrapers (Sovereign 10Y/2Y Yields, CDS Proxies)
            │
            ▼
[ Ingestion & ETL Layer ]
  ├── Market Data Normalizer
  ├── Options Chain & Volatility Surface Parser
  └── Yield Curve & Spread Calculation Engine
            │
            ▼
[ Quantitative Strategy & Return Engine ]
  ├── Futures Basis & Carry Engine
  ├── Options / Volatility Engine (Straddles, VRP, Delta-Neutral)
  ├── Sovereign Debt & Yield Spread Engine (10Y-2Y, UST/Bund Spreads)
  ├── CDS & Sovereign Credit Risk Engine
  └── IRF / Swap Spread Engine
            │
            ▼
[ Storage & Caching Layer ]
  ├── PostgreSQL + PostGIS (GeoJSON & Time-Series)
  └── Redis Cache (Fast Heatmap & Country Drill-Down Endpoints)
            │
            ▼
[ FastAPI GeoJSON / Country Drill-Down API Engine ]
```

---

## 2. Free Data Source Mapping

| Asset Class / Instrument | Free Source API | Data Extracted / Derived |
| :--- | :--- | :--- |
| **Sovereign Bond Yields** | FRED API / Scraping | 2Y, 5Y, 10Y, 30Y Sovereign Yields per country |
| **Yield & Swap Spreads** | FRED API / YFinance | 10Y - 2Y slope, Country Yield vs. US Treasury / Bund Spread |
| **Country Equity & Futures** | YFinance | Country ETFs (EWG, EWJ, INDA, EWZ, EEM), Index Futures |
| **Options Chains & Volatility**| YFinance | ETF/Index Options Call/Put prices, Implied Volatility (IV) surface |
| **Straddles & Vol Strategies** | Derived via Options| ATM Straddle prices, Vol Risk Premium (IV - RV) |
| **Interest Rate Futures (IRF)**| YFinance / FRED | SOFR Futures, Euribor Futures, Treasury Futures |
| **CDS & Credit Risk** | Derived Proxy | Implied CDS = Yield_Country,USD - Yield_UST |

---

## 3. Quantitative Strategy & Return Calculations

**1. Sovereign Bonds & Spreads**
* **Real Yield:** `Y_Real = Y_10Y - Expected_Inflation`
* **Term Spread (Slope):** `Slope = Y_10Y - Y_2Y`

**2. Credit Default Swaps (CDS)**
* **Implied Spread (bps):** `CDS_Proxy ≈ (Y_Country_USD_Bond - Y_US_Treasury) * 10,000`

**3. Volatility & Options (Straddles)**
* **Realized Volatility (RV_30d):** 30-day historical standard deviation annualized.
* **Volatility Risk Premium (VRP):** `VRP = IV_ATM_30d - RV_30d`
* **Short Straddle Yield (Annualized):** `R_Straddle = (P_Straddle / Spot) * √(365 / DTE)`

**4. Futures Carry**
* **Annualized Basis Yield:** `Basis = ((Futures_Price - Spot) / Spot) * (365 / DTE)`

---

## 4. Database Schema (PostgreSQL/TimescaleDB)

```sql
CREATE TABLE countries (
    country_code VARCHAR(3) PRIMARY KEY,
    country_name VARCHAR(100) NOT NULL,
    geometry GEOMETRY(MultiPolygon, 4326)
);

CREATE TABLE country_financial_metrics (
    timestamp TIMESTAMPTZ NOT NULL,
    country_code VARCHAR(3) REFERENCES countries(country_code),
    
    yield_2y NUMERIC(8,4),
    yield_10y NUMERIC(8,4),
    yield_spread_vs_ust NUMERIC(8,4),
    
    cds_spread_bps NUMERIC(8,2),
    
    index_futures_basis_ann NUMERIC(8,4),
    
    implied_vol_30d NUMERIC(8,4),
    realized_vol_30d NUMERIC(8,4),
    volatility_risk_premium NUMERIC(8,4),
    straddle_yield_ann NUMERIC(8,4),
    
    composite_heatmap_score NUMERIC(8,4),
    PRIMARY KEY (timestamp, country_code)
);
```

---

## 5. Python Data Pipeline (pipeline.py)

```python
import asyncio
import math
from datetime import datetime
import numpy as np
import scipy.stats as si
import yfinance as yf
import pandas as pd

COUNTRY_MAP = {
    "USA": {"etf": "SPY", "futures": "ES=F", "10y_yield_ticker": "^TNX", "name": "United States"},
    "DEU": {"etf": "EWG", "futures": "FDAX.EX", "10y_yield_ticker": "DE10YT=X", "name": "Germany"},
    "JPN": {"etf": "EWJ", "futures": "NK=F", "10y_yield_ticker": "JP10YT=X", "name": "Japan"}
}

class FinancialPipelineEngine:
    def __init__(self):
        self.benchmark_10y_yield = 0.042

    def calculate_iv(self, S, K, T, r, market_price, flag='c'):
        sigma = 0.20
        for _ in range(20):
            d1 = (np.log(S / K) + (r + 0.5 * sigma ** 2) * T) / (sigma * np.sqrt(T))
            d2 = d1 - sigma * np.sqrt(T)
            price = S * si.norm.cdf(d1) - K * np.exp(-r * T) * si.norm.cdf(d2) if flag == 'c' else K * np.exp(-r * T) * si.norm.cdf(-d2) - S * si.norm.cdf(-d1)
            vega = S * si.norm.pdf(d1) * np.sqrt(T)
            diff = price - market_price
            if abs(diff) < 1e-4: return sigma
            if vega < 1e-6: break
            sigma -= diff / vega
        return max(sigma, 0.01)

    def process_volatility(self, etf_ticker):
        ticker = yf.Ticker(etf_ticker)
        hist = ticker.history(period="60d")
        if hist.empty: return {}
        
        spot = hist["Close"].iloc[-1]
        returns = np.log(hist["Close"] / hist["Close"].shift(1)).dropna()
        rv_30d = float(returns.tail(30).std() * np.sqrt(252))
        
        # Simplified options pull
        opts = ticker.options
        if not opts: return {"rv_30d": rv_30d}
        
        chain = ticker.option_chain(opts[0])
        calls = chain.calls
        calls["strike_diff"] = abs(calls["strike"] - spot)
        atm = calls.sort_values("strike_diff").iloc[0]
        
        iv = self.calculate_iv(spot, atm["strike"], 30/365.0, self.benchmark_10y_yield, atm["lastPrice"])
        return {"spot": spot, "rv_30d": rv_30d, "iv_30d": iv, "vrp": iv - rv_30d}

    async def execute(self):
        results = {}
        for code, config in COUNTRY_MAP.items():
            vol_data = self.process_volatility(config["etf"])
            results[code] = {
                "country": config["name"],
                "heatmap_score": vol_data.get("vrp", 0.0) * 10, # Simplified scoring
                "metrics": vol_data
            }
        return results

if __name__ == "__main__":
    engine = FinancialPipelineEngine()
    print(asyncio.run(engine.execute()))
```

---

## 6. FastAPI Backend (api.py)

```python
from fastapi import FastAPI, HTTPException
app = FastAPI()
LATEST_CACHE = {} # Populated by pipeline run

@app.get("/api/v1/heatmap")
async def get_heatmap_geojson():
    features = []
    for code, data in LATEST_CACHE.items():
        features.append({
            "type": "Feature",
            "properties": {
                "country_code": code,
                "country_name": data["country"],
                "heatmap_score": data["heatmap_score"],
            },
            "geometry": {"type": "Point", "coordinates": [0.0, 0.0]}
        })
    return {"type": "FeatureCollection", "features": features}
```
