# CSV Cleaner

Upload a CSV, clean headers, trim cells, drop empty columns, remove duplicates, optionally normalize date-ish columns, then download the cleaned CSV. Preview stats are returned via headers and shown in the UI.

## Project structure
- server/: Flask + pandas API (`/api/clean-csv`)
- client/: Vite + React + Tailwind frontend

## Run locally
Backend
```
cd server
python -m venv .venv
source .venv/bin/activate  # Windows: .venv\Scripts\activate
pip install -r requirements.txt
python app.py
```

Frontend
```
cd client
npm install
npm run dev
```

Open the Vite dev URL. The proxy sends `/api/*` to Flask.

## Deploy
Set in your frontend environment:
```
VITE_API_URL=https://your-backend-domain.com
```
Locally you can leave it empty because the proxy handles it.

## Docker (local)
- Build & run both services:
  ```
  docker compose up --build
  ```
  Frontend: http://localhost:4173 (Nginx serving built assets, proxying `/api` to backend). Backend: http://localhost:5000.
- Just backend image:
  ```
  cd server
  docker build -t csv-cleaner-backend .
  docker run -p 5000:5000 csv-cleaner-backend
  ```

## Data handling
- UTF-8 CSV uploads up to 20 MB.
- Values are read as text to retain leading zeros and literal `NA` values.
- Whitespace is trimmed before empty columns and duplicate rows are removed.
- Date conversion is opt-in and only converts year-first dates (`YYYY/MM/DD` or `YYYY-MM-DD`). Ambiguous dates, timestamps and invalid values are preserved.
- Processing takes place in server memory; the app does not persist uploaded files.

## Checks
```sh
python -m unittest discover -s server -v
cd client && npm ci && npm run build
```
