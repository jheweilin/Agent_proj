# Getting COMSOL figures and data out of a job

Since 2026-11-03 the lab's COMSOL service runs `comsol batch -3drend sw` (software rendering on the headless
server) and returns **every file the model writes to its working directory**. The working directory is the
job's upload directory, so export nodes with relative file names (`./potential.png`, `./profile.txt`) come back
in `output_files` and can be downloaded. Java code itself still cannot read/write files or read system
properties (service security settings); COMSOL export nodes can.

## 1. Native COMSOL figures (preferred)

Build plot groups as you would in the GUI, then export each one with `exportImage` from `PlotDataDemo.java`:

```java
exportImage(model, "pg1", "potential.png", 1200, 900);   // title, axes and colour legend on
```

It uses an `Image` export node with `set("plotgroup", pg)` and `set("filename", "./<file>")`.
Verified plot types: `Surface`, `Contour`, `ArrowSurface` in `PlotGroup2D`, and `LineGraph` on a `CutLine2D`
dataset in `PlotGroup1D` (see the demo). The demo job produced `potential.png`, `efield.png` and
`potential_line.png` (1200×900, rendered by COMSOL).

Tips:
- Run the plot group (`model.result(pg).run()`) before exporting; `exportImage` does this.
- One image per plot group; use distinct file names.
- For axisymmetric models, a `Revolution2D` dataset gives a 3D-looking view; plain 2D plots are usually clearer.
- For time-dependent or periodic studies, set the plot group's `looplevel` (time index) before exporting, or
  export several images.

## 2. Data files

`Data` export nodes also come back, e.g. a regular grid:

```java
model.result().export().create("data1", "Data");
model.result().export("data1").set("data", "dset1");
model.result().export("data1").set("expr", new String[]{"V", "es.normE"});
model.result().export("data1").set("location", "regulargrid");
model.result().export("data1").set("regulargridx2", 101);
model.result().export("data1").set("regulargridy2", 101);
model.result().export("data1").set("filename", "./field.txt");
model.result().export("data1").run();
```

## 3. Numbers in the log (for checking)

`dumpGrid2D`, `dumpLine` and `dumpTable` print values between `#PA_DATA_BEGIN ... #PA_DATA_END` markers in the
log. The platform turns them into CSV files with quick-look plots and reports min/max/mean per dataset
(`collected.data_stats`), which is the fastest way to sanity-check results. They use `Interp` with
`set("coord", double[2][N])`; `getReal()` returns one row per point (`v[p][0]`).

## What happens after the job

`comsol_job` (when a batch job completes) downloads everything to `/workspace/comsol/<job_id>/` and attaches it
for the user: COMSOL images first (`collected.comsol_images`), then quick-look plots from data blocks, the
`.mph` and `.mph.status` files, and data files. Look at the images with `see_image` before describing them.
