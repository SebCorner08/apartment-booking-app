# Pricing configuration

The server is authoritative for all booking prices. Browser-supplied rates,
subtotals, taxes and totals are ignored.

## Runtime source of truth

The newest row in the SQLite `tax_settings` table is the single runtime source
of truth for:

- nightly rate;
- monthly rate;
- weekly rate (zero disables weekly rentals);
- cleaning fee;
- Mecklenburg sales tax;
- Mecklenburg occupancy tax;
- minimum nights.

The admin tax-settings endpoint creates a new complete snapshot. Any omitted
field is copied from the latest row, so changing taxes cannot reset nightly,
monthly, weekly, cleaning-fee or minimum-stay values.

## Weekly rentals

Weekly rentals are unavailable until the owner saves a positive **Weekly Rental
Rate (USD)** in the admin pricing page. Save zero to disable them. The rate is
never inferred from the nightly/monthly prices or the issue's example amount.

`GET /api/weekly-rate` returns `weekly_rate` and `available`. Quote and checkout
requests use `rental_type: "weekly"` and valid `checkIn`/`checkOut` dates. The
server derives 1–52 whole weeks (7 nights each) from those dates and ignores
client-supplied weeks, rates and totals. The short-stay `minimum_nights` applies
only to short stays; weekly rentals have a seven-night minimum. Weekly pricing
uses the existing short-stay tax and cleaning-fee rules, including both taxes on
lodging plus the one-time cleaning fee. Holds, Stripe metadata and confirmed
bookings retain the distinct `weekly` rental type.

## Environment variables

`NIGHTLY_RATE`, `MONTHLY_RATE`, `CLEANING_FEE`,
`TAX_MECKLENBURG_SALES`, `TAX_MECKLENBURG_OCCUPANCY` and
`MINIMUM_NIGHTS` are bootstrap/fallback defaults only. They apply when no
database row exists or a migrated column is null. After a row exists, editing
environment variables does not override the stored runtime configuration.

## Migration and rollback

Existing databases gain nullable-compatible `cleaning_fee` and
`minimum_nights` columns. Existing rows receive the validated environment
bootstrap values for those newly introduced fields while existing nightly and
monthly rates are preserved. Rollback consists of reverting the application
commit; SQLite may retain the additive columns and older code safely ignores
them.

The weekly migration adds `tax_settings.weekly_rate REAL NOT NULL DEFAULT 0`.
It preserves existing settings rows, rates and bookings; all historical pricing
rows and new databases initially have weekly rentals disabled. No production
rate needs changing as part of deployment. After deployment, the owner chooses
the desired rate through the authenticated admin page.

Before rollback, disable weekly rentals and allow active weekly checkouts to
complete or expire. Revert the application commit while keeping the additive
column and historical weekly bookings. Older code ignores the column and can
still persist an already-created weekly Stripe session, although its admin UI
may label that booking as a short stay. Older pricing saves omit the new column
and therefore create snapshots with weekly disabled; when upgrading again,
check and explicitly re-enable the owner's chosen rate. Do not drop pricing
history or rewrite weekly booking records during rollback.
