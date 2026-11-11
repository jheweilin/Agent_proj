# Universal research sandbox: the existing plasma image + a broad cross-field open-source stack
# (business/IE optimisation & stats, spatial/architecture geometry, text/doc tooling, R).
# Built locally and pulled by the worker via the Docker API — no registry push needed.
# Build: docker build -f deploy/sandbox-general.Dockerfile \
#   --build-arg PIP_INDEX_URL=https://mirrors.aliyun.com/pypi/simple/ \
#   -t plasma-agent-sandbox:general-1.0 deploy/
ARG BASE=public.ecr.aws/z1o8z4f9/agent:plasma-1.1.0
FROM ${BASE}

ARG PIP_INDEX_URL=https://pypi.org/simple
ENV DEBIAN_FRONTEND=noninteractive

# system packages: R (stats/business/humanities), GDAL (geo/architecture), doc & diagram tooling
RUN apt-get update && apt-get install -y --no-install-recommends \
      r-base-core gdal-bin libgdal-dev pandoc graphviz imagemagick \
    && rm -rf /var/lib/apt/lists/*

# broad open-source Python stack (base already has numpy/scipy/pandas/matplotlib/plotly/pytorch).
# use the image's own venv pip so packages land where the agent runs them.
RUN /opt/venv/bin/pip install --no-cache-dir -i ${PIP_INDEX_URL} \
      statsmodels scikit-learn seaborn sympy networkx openpyxl pyarrow xlrd \
      pulp ortools cvxpy \
      shapely pyproj trimesh geopandas rasterio \
      nltk beautifulsoup4 lxml requests python-docx markdown pypdf

LABEL org.opencontainers.image.description="Universal research sandbox (plasma base + cross-field open-source tools)"
