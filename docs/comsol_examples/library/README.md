# COMSOL official Application Library (read-only)

`/comsol_examples` in the sandbox is the COMSOL 6.4 Application Library: 44 module folders, 2,094 `.mph` models, plus
the data files they use (`.txt` cross sections, parameters and tables; `.mphbin` geometry; `.csv`, `.stl`, ...).
No documentation PDFs and no Java files are included. It is mounted read-only.

Start with `Plasma_Module/` (subfolders such as `Capacitively_Coupled_Plasmas`, `Inductively_Coupled_Plasmas`,
`Direct_Current_Discharges`, `Corona_Discharges`, `Two-Term_Boltzmann_Equation`) and `Electric_Discharge_Module/`.

## Find a model

The `read_file` and `list_files` tools only work inside `/workspace`; use `execute_command` here.

```bash
ls /comsol_examples/Plasma_Module/*/
find /comsol_examples -iname '*corona*' -name '*.mph' -printf '%s %p\n'
```

## Read how a model is built

The sandbox has no COMSOL, so a `.mph` cannot be opened here. Have the COMSOL service export it as Java:

1. Copy what you need into `/workspace`; `comsol_submit` only attaches files found there.
   `cp /comsol_examples/Plasma_Module/Direct_Current_Discharges/positive_column_1d.mph /workspace/`
2. Copy `ExportModelJava.java` from this folder to `/workspace` and set the model file name in it.
3. `comsol_submit(main_file="ExportModelJava.java", mode="batch")`, then `comsol_job`. This loads and saves only; it does
   not solve. Verified 2026-11-06 on `positive_column_1d.mph`: about 13 s, 234 lines of Java.
4. Read the exported file in `/workspace/comsol/<job_id>/`. It lists the geometry, physics, study and plot settings.

Use exactly the save call in the template. The service does not return `.java` files, so the export must be saved as
`./name.txt`; other file names tried (`./x.java.txt`, no extension) did not come back.

## Reusing a model

- Treat the export as a reference: copy feature types, property names and settings from it, then adapt to the user's case.
- To run it, rename the file to `.java`, make the class name match the file name, and delete the `model.modelPath(...)`
  line. Check it with `mode: "compile"` first. Refer to data files by bare file name and copy them into `/workspace`.
- Say which library model you started from and what you changed. A library model is a starting point, not validation
  of the user's case.
- Library models may not contain a stored solution, and some were built for long solves. Do not assume you can
  post-process results from one, and tell the user before starting a solve that will take more than a few minutes.
