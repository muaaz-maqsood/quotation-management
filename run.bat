@echo off
REM Start the TMC Quote web app, connected to the local Odoo instance.
REM Adjust ODOO_URL / ODOO_DB / ODOO_USER / ODOO_PASS if the defaults do not match.

set ODOO_URL=https://demo.tallymarkscloud.com:8046
set ODOO_DB=TMC_Prod_Ess
set ODOO_USER=admin
set ODOO_PASS=admin
set WEB_HOST=127.0.0.1
set WEB_PORT=5066

cd /d "%~dp0"
python server.py
pause
