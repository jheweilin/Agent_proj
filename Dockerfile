# ---- web UI build ----
FROM node:20-alpine AS web
WORKDIR /web
COPY web/package.json web/package-lock.json* ./
RUN npm install --no-audit --no-fund
COPY web/ ./
RUN npm run build

# ---- python app (api + worker) ----
FROM python:3.12-slim
ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1
WORKDIR /app
COPY backend/requirements.txt ./
# pypi.org is slow from this host; pass --build-arg PIP_INDEX_URL=<mirror> to use a faster index
ARG PIP_INDEX_URL=
RUN pip install --no-cache-dir ${PIP_INDEX_URL:+--index-url=$PIP_INDEX_URL} -r requirements.txt
COPY backend/plasma_agent ./plasma_agent
COPY prompts ./prompts
COPY docs/AGENT_GUIDE.md ./guides/AGENT_GUIDE.md
COPY docs/comsol_examples ./guides/comsol_examples
COPY docs/guide_tools ./guides/tools
COPY --from=web /web/dist ./static
EXPOSE 8000
CMD ["uvicorn", "plasma_agent.api:app", "--host", "0.0.0.0", "--port", "8000", "--proxy-headers"]
