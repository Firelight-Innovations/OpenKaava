# veistra-api on Cloud Run. The stock Python image with two stdlib-only files copied in: nothing is
# installed, so the image has no dependencies of ours to patch.
#
# Built by `infra/deploy.sh veistra-api`, which stages this file, veistra_api.py and
# infra/common/veistra-wake/veistra_wake.py into one context. The image tag is the first 12 hex digits
# of the SHA-256 of those three files in that order, and infra/terraform/veistra-api computes the same
# value, so a change to any of them is a new tag and a new revision.

# python:3.12-slim, 3.12.14 on Debian trixie, 2026-09-28 (the same digest as plane-watch).
FROM python@sha256:f77ac9e44ae96ef2c90b8053ea08c31f8be030f824196b0ae4db6d462c84e51f

WORKDIR /app
COPY veistra_wake.py veistra_api.py ./
USER nobody
ENV PYTHONUNBUFFERED=1 PYTHONDONTWRITEBYTECODE=1
CMD ["python", "/app/veistra_api.py"]
