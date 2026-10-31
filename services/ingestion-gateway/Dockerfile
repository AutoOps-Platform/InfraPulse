FROM python:3.12.16-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337 AS build
COPY --from=ghcr.io/astral-sh/uv:0.13.6 /uv /uvx /bin/
WORKDIR /app
ENV UV_LINK_MODE=copy UV_PYTHON_DOWNLOADS=never
COPY pyproject.toml uv.lock ./
RUN uv sync --frozen --no-dev --no-install-project

# Task 8 can build this target explicitly; it is never the service image.
FROM build AS test
RUN uv sync --frozen --group dev --no-install-project
COPY app/ ./app/
COPY tests/ ./tests/
ENV PYTHONPATH=/app
ENTRYPOINT ["/app/.venv/bin/python", "-m"]
CMD ["pytest"]

# Default production target: no uv, test source, compiler or dev environment.
FROM python:3.12.16-slim-bookworm@sha256:e697c81897302a4c4333bade000d98038fbb21eb064f8ee1fd42d02ebcd9d337 AS runtime
RUN groupadd --gid 10001 ingest && useradd --uid 10001 --gid 10001 --no-create-home --shell /usr/sbin/nologin ingest
WORKDIR /app
ENV PATH="/app/.venv/bin:$PATH" PYTHONDONTWRITEBYTECODE=1
COPY --from=build /app/.venv /app/.venv
COPY app/ ./app/
USER 10001:10001
CMD ["uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "8000", "--workers", "1", "--no-access-log"]
