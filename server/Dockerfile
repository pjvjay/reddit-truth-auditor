# Build from the repository root (the image needs spec/outlets.json):
#   docker build -f server/Dockerfile -t rta-community-server .
#   docker run -p 8080:8080 -v rta-data:/data rta-community-server
FROM python:3.12-slim
WORKDIR /app
COPY spec/ /app/spec/
COPY server/ /app/server/
RUN pip install --no-cache-dir /app/server && useradd --system --home /data rta && mkdir -p /data && chown rta /data
USER rta
ENV RTA_DB=/data/community.sqlite3 RTA_HOST=0.0.0.0 RTA_PORT=8080
EXPOSE 8080
CMD ["rta-server"]
