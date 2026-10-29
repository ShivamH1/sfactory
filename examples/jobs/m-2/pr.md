# Export the orders list as CSV

Adds a download button to the orders list and a server route that streams the rows as CSV.

- Columns follow the table, in the same order.
- Dates are written as ISO calendar days.
- Tests cover quoting of commas and newlines.
