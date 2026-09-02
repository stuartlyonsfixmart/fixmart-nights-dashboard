# fixmart-nights-dashboard

Warehouse nights operations dashboard — Fixmart Ltd.
Built on Node.js / Express / BigQuery / Cloud Run.

Tabs: Picking | Packing | Goods In | Replenishment | Trends

No login. Anyone with the Cloud Run URL can view it, same as the stock
and failed-deliveries dashboards. Deploy:

```
gcloud run deploy fixmart-nights-dashboard --source . --region europe-west2
```
