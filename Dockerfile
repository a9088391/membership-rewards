FROM node:24.22.2-bookworm-slim@sha256:01d566e8d94d8c619591d78652babfccd3c6992a3dffa9ed5ab39e11cf6c70e9 AS backend
RUN apt-get update && apt-get install -y --no-install-recommends openssl ca-certificates \
    && rm -rf /var/lib/apt/lists/*
WORKDIR /workspace
COPY backend/package.json backend/package-lock.json ./backend/
RUN npm --prefix backend ci
COPY backend ./backend
RUN npm --prefix backend run build
COPY docker/with-database.sh /usr/local/bin/with-database
ENTRYPOINT ["/bin/sh", "/usr/local/bin/with-database"]

FROM backend AS application
ENV NEXT_TELEMETRY_DISABLED=1
COPY frontend/package.json frontend/package-lock.json ./frontend/
RUN npm --prefix frontend ci
COPY frontend ./frontend
RUN npm --prefix frontend run build
ENV NODE_ENV=production
CMD ["sh", "-ec", "npm --prefix backend run migrate:deploy && npm --prefix backend run seed && exec node frontend/server.mjs"]
