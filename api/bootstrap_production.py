"""Apply DB migrations and create any configured first-run roles before a Vercel deploy."""
from dotenv import load_dotenv

load_dotenv(".vercel/.env.production.local", override=True)

import main

main.init()
