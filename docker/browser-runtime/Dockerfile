FROM mcr.microsoft.com/playwright:v1.62.1-noble

USER root
RUN apt-get update \
    && apt-get install --yes --no-install-recommends libnss3-tools \
    && rm -rf /var/lib/apt/lists/*

ENV HOME=/home/pwuser \
    PLAYWRIGHT_BROWSERS_PATH=/ms-playwright

WORKDIR /home/pwuser
USER pwuser

LABEL org.opencontainers.image.title="BSTG Browser Runtime" \
      org.opencontainers.image.description="Headless Playwright runtime for authorized BSTG browser testing; includes Chromium and NSS certutil." \
      org.opencontainers.image.source="https://github.com/SEc-123/BolaSecurityTestGate" \
      org.opencontainers.image.base.name="mcr.microsoft.com/playwright:v1.62.1-noble"
