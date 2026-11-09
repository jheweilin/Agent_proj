# Post-processing an existing COMSOL result without re-solving

The sandbox has no COMSOL installation, so it cannot open `.mph` files itself (the MPh Python package is
installed but only works with a local COMSOL install; `mph.discovery.find_backends()` is empty). Instead, send
the `.mph` back to the COMSOL service together with a small Java program that loads it:

```java
Model model = ModelUtil.load("Loaded", "MyModel_result_Model.mph");   // bare file name
```

`comsol_submit(main_file="PostProcess.java", mode="batch")` attaches the referenced `.mph` automatically (since
2026-11-03 the service accepts `.mph` files as data files when a `.java`/`.class` is the main file). The stored
solution is used as is; nothing is re-solved unless you call a study.

`PostProcess.java` (verified 2026-11-03: load 4.5 s, total job 12 s for a small model) shows how to:

- list plot groups, datasets and parameters of the loaded model (print them first, then use the right tags);
- evaluate new quantities (`MaxSurface`, `AvSurface`, `EvalGlobal`, `Interp`, ...) — numerical features need
  `set("data", "<dataset>")` **and** `selection().all()` (or a named selection), otherwise you get NaN or 0;
- create a new plot group and export it with an `Image` node (`plotgroup`, `./file.png`), or reuse an existing
  plot group tag.

Use it when the user asks for extra figures or numbers from a model that already ran, especially long solves
(e.g. the GEC CCP model, ~20 min). The downloaded results of every finished job are in
`/workspace/comsol/<job_id>/`; the main model is `<Class>_result_<tag>.mph` (the largest `.mph` there).
Copy the `.mph` next to the Java file or reference it by its bare name (the tool finds it in `/workspace`).
