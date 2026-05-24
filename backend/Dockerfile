FROM python:3.12-slim
WORKDIR /app
COPY backend/requirements.txt .
RUN pip install --no-cache-dir --root-user-action=ignore -r requirements.txt
COPY backend/ .
EXPOSE 3001
CMD ["sh", "-c", "python manage.py migrate --noinput && uvicorn oekaki.asgi:application --host 0.0.0.0 --port ${PORT:-3001}"]
