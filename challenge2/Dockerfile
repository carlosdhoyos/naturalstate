# Vegetation QA/QC job image: runs the whole pipeline (rules, marts, effort, figures, dashboard JSON) on
# mounted ODK exports, entity lists and forms, and writes everything to a mounted output folder.
# The run is offline: GBIF names and SRTM elevations come from the cached files in reference/.
#
# Build (from the repository root):
#   docker build -t vegqa:1.0.0 challenge2
# Run on the take-home data:
#   docker run --rm \
#     -v "$PWD/Data Vegetation/ODK Data Exports:/data/exports:ro" \
#     -v "$PWD/Data Vegetation/Entity lists:/data/entities:ro" \
#     -v "$PWD/Data Vegetation/ODK Data Collection Forms:/data/forms:ro" \
#     -v "$PWD/challenge2/out:/out" vegqa:1.0.0
FROM python:3.13-slim

ENV PYTHONDONTWRITEBYTECODE=1 PYTHONUNBUFFERED=1 PIP_NO_CACHE_DIR=1 MPLCONFIGDIR=/tmp/matplotlib VEGQA_IMAGE=vegqa:1.0.0
WORKDIR /app/challenge2

COPY requirements.txt ./
RUN pip install -r requirements.txt && useradd --create-home --uid 10001 worker

COPY rules ./rules
COPY reference ./reference
COPY src ./src

USER worker
ENTRYPOINT ["python", "src/run_challenge2.py", "--exports", "/data/exports", "--entities", "/data/entities", "--forms", "/data/forms", "--out", "/out"]
