#!/bin/bash
# Doppio clic dal Finder: apre il pannello dell'addestramento nel browser.
cd "$(dirname "$0")"
exec .venv/bin/python pannello.py
