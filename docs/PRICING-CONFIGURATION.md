# Pricing configuration

The server is authoritative for all booking prices. Browser-supplied rates,
subtotals, taxes and totals are ignored.

## Runtime source of truth

The newest row in the SQLite `tax_settings` table is the single runtime source
of truth for:

- nightly rate;
- monthly rate;
- cleaning fee;
- Mecklenburg sales tax;
- Mecklenburg occupancy tax;
- minimum nights.

The admin tax-settings endpoint creates a new complete snapshot. Any omitted
field is copied from the latest row, so changing taxes cannot reset nightly,
monthly, cleaning-fee or minimum-stay values.

## Environment variables

`NIGHTLY_RATE`, `MONTHLY_RATE`, `CLEANING_FEE`,
`TAX_MECKLENBURG_SALES`, `TAX_MECKLENBURG_OCCUPANCY` and
`MINIMUM_NIGHTS` are bootstrap/fallback defaults only. They apply when no
database row exists or a migrated column is null. After a row exists, editing
environment variables does not override the stored runtime configuration.

## Migration and rollback

Existing databases gain nullable-compatible `cleaning_fee` and
`minimum_nights` columns with safe defaults. Existing nightly and monthly
rates are preserved. Rollback consists of reverting the application commit;
SQLite may retain the additive columns and older code safely ignores them.
