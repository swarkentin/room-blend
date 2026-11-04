# Keep this Playwright version aligned with package-lock.json and ci.yml.
FROM mcr.microsoft.com/playwright:v1.64.1-noble

LABEL org.opencontainers.image.source="https://github.com/swarkentin/room-blend"

ENV DEBIAN_FRONTEND=noninteractive

RUN apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 update \
    && apt-get -o Acquire::Retries=3 -o Acquire::http::Timeout=30 -o Acquire::https::Timeout=30 install --yes --no-install-recommends \
      ffmpeg \
      python3-opencv \
    && apt-get clean \
    && rm -rf /var/lib/apt/lists/*
