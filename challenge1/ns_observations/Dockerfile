# ns-observations worker image: Python 3.13 (the NS Analytics stack), numpy + pandas, schema validation.
# Build:  docker build -t ns-observations:1.0.0 challenge1/ns_observations
# Run:    docker run --rm -v "$PWD/Data Birds:/data" -v "$PWD/out:/out" ns-observations:1.0.0 \
#           run --predictions /data/birdnet_predictions.csv --validations /data/validation_results.csv \
#               --out /out/threshold_set.json --labels-out /out/labels.csv
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1
WORKDIR /app

COPY pyproject.toml README.md ./
COPY src ./src
RUN pip install ".[schema]" && useradd --create-home --uid 10001 worker

USER worker
ENTRYPOINT ["ns-observations"]
CMD ["--help"]
