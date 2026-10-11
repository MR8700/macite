FROM python:3.12-slim
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY main.py places.py security.py alembic.ini ./
COPY macite_ai ./macite_ai
COPY migrations ./migrations
RUN useradd -m app && chown -R app /app
USER app
CMD ["uvicorn", "main:app", "--host", "0.0.0.0", "--port", "8000"]
