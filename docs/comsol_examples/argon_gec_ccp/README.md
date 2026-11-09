# COMSOL reference model: GEC CCP reactor, argon chemistry (Plasma Module)

Official COMSOL Application Library model `Plasma_Module/Capacitively_Coupled_Plasmas/argon_gec_ccp`.
Files in this folder:

- `argon_gec_ccp.java` — the model **exported by COMSOL 6.4.0.293 itself** ("File > Save as Java").
  Every API call in it is known-good for the lab's COMSOL 6.4 service. The only edit: the
  Windows `model.modelPath(...)` line was removed.
- `Ar_xsecs_reduced.txt` — LXCat-format electron–argon cross sections (elastic, excitation 11.5 eV,
  ionisation 15.8 eV) read by the Cross Section Import feature.

Use this file as the source of truth for Plasma Module API names (feature types, property names,
species tags) instead of guessing them.

## Verified on the lab service (2026-11-03)

A minimal job that creates `ColdPlasmaTimePeriodic` and runs `CrossSectionImport` + `importData`
with this cross-section file ran without errors: **the Plasma Module licence works**.
After the import, the `ptp` interface contains these feature tags:
`pes1, init1, ins1, axi1, zc1, xsec1, eir1, eir2, eir3, e, Ar, Ars, Ar_1p` —
species tags are `e`, `Ar`, `Ars` (metastable), `Ar_1p` (Ar+); reactions are `eir1..eir3`.

## Physics summary

- 2D axisymmetric (r, z), **Plasma, Time Periodic** interface (`ptp`, type `ColdPlasmaTimePeriodic`)
  with a **Time Periodic** study: periodic steady state of a 13.56 MHz discharge, argon at 100 mTorr
  (`pA = 0.1[torr]`), gas temperature 300 K.
- Parameters: `L = 2.54[cm]` (gap), `R1 = 5.38[cm]`, `R2 = 10.16[cm]`, `Hd = 10.16[cm]`,
  `dThick = 3[mm]`, `f0 = 13.56[MHz]`, `P0 = 1[W]`.
- Geometry: rectangle r1 (R1 × L) + rectangle r2 (R2−R1 × Hd, at r = R1, z = −Hd/2+L/2), points for the
  dielectric break and a line segment, then MeshControlEdges on boundaries 4 and 9.
- Extra dimension: `Period_xd = 1/f0`, `Nelemptp = 30` elements per RF period,
  `HeavySpeciesSelection = BaseGeometry` (heavy species solved only in the base geometry).
- Chemistry: e+Ar elastic, e+Ar→e+Ars (11.5 eV), e+Ar→2e+Ar+ (15.8 eV); `Ars` is **disabled**
  (`feature("Ars").active(false)`) as in the reference paper. `Ar` from mass constraint; `Ar_1p` initial
  value from electroneutrality, mobility from the built-in table `ArIoninAr`, ion temperature by the local
  field approximation.
- Surface reaction `Ar+=>Ar` on all walls, sticking 0 (`gammaf = 0`); secondary emission 0.07 with
  5.8 V mean energy (from the Ar+ species data).
- Electron transport: `SpecifyMueOnly`, `mue = 3E5[cm^2/(V*s)]/0.1` (isotropic tensor written out as 9 entries).
- Wall: `WallDriftDiffusion` with reflection coefficient `re = 5/11`.
- Driven electrode: `MetalContact` with **fixed RF power** `Prf = P0`, `fp = f0`, `CompBias = true`
  (computes the DC self-bias). Driving by power is much more stable than driving by voltage.
- `DielectricContact` on boundaries 4, 6; `Ground` on boundaries 3, 5, 7–12.
- Mesh: mapped mesh with five Distribution nodes, fine near the electrodes (element ratios 3–10).
- Study 2 (`TimePeriodicToTimeDependent`, 51 values over one period) converts the periodic solution to
  the time domain for animations; it runs in seconds.

## Expected results (1 W absorbed power), from the COMSOL documentation

- RF voltage amplitude `ptp.mct1.Va_per` ≈ **100 V**, DC self-bias `ptp.mct1.Vdcb_per` ≈ **−78 V**
  (strong negative bias because the reactor is electrically asymmetric).
- Period-averaged electron density peaks **off-axis** at ≈ 2.2×10¹⁵ m⁻³ inside the small gap.
- On-axis density rises from ~0 at the driven electrode to a maximum ≈ 1.75×10¹⁵ m⁻³ at z ≈ 0.0135 m.
- Period-averaged electron temperature is highest (~18 V) in the sheath of the powered electrode,
  ~3–4 V in the bulk.
- Reference: J.P. Boeuf and L.C. Pitchford, Phys. Rev. E 51, 1376 (1995); cross sections: Phelps
  database, www.lxcat.net.
- Note: the Plasma Module computes ⟨Te⟩ = (2/3)⟨nε/ne⟩; the reference paper's definition corresponds to
  (2/3)⟨nε⟩/⟨ne⟩.

## How to run it on the lab service

1. Copy both files into the workspace. The Java public class name must equal the file name
   (`argon_gec_ccp`), and the cross-section file must be sent with the job:
   `comsol_submit(main_file="argon_gec_ccp.java", data_files=["Ar_xsecs_reduced.txt"], mode="compile")`,
   then `mode="batch"`.
2. The exported `main` only calls `run()`. The service saves the model to `<name>_result_Model.mph`
   automatically, but nothing is printed. To get checkable numbers, add prints after the solve, e.g.
   ```java
   Model model = run();
   model.result().numerical().create("gchk", "EvalGlobal");
   model.result().numerical("gchk").set("data", "dset1");
   model.result().numerical("gchk").set("expr", new String[]{"ptp.mct1.Va_per", "ptp.mct1.Vdcb_per"});
   double[][] v = model.result().numerical("gchk").getReal();
   System.out.println("RESULT_Va_V=" + v[0][0]);
   System.out.println("RESULT_Vdcb_V=" + v[1][0]);
   ```
   (`getReal()` returns one row per expression; check the array shape by printing `v.length` and
   `v[0].length` if unsure.) `main` must be declared `throws java.io.IOException` if you call
   `model.save(...)`.
3. **Run time**: the full model takes ~20 minutes on a desktop and the lab service runs one job at a
   time for everyone. Tell the user before submitting the full solve. For pipeline tests, compile only,
   or build up to the mesh and stop (no `runAll()`), which takes seconds.
4. Explicit boundary numbers (`selection(...).set(2, 3, ...)`) are reliable here **only because the
   geometry is built exactly as in this file**. If you change the geometry, re-derive the boundaries
   (Box selections by coordinates, then print the entity counts).

## Adapting it

- Other gas or pressure: replace the cross-section file (LXCat format: block title, formula, energy loss
  or mass ratio, then two-column energy/cross-section table), update `pA`, species presets and the surface
  reaction. Re-check species tags after `importData` by printing `physics("ptp").feature().tags()`.
- Other power or frequency: change `P0`, `f0`; keep `Period_xd = 1/f0`.
- Steady (non-periodic) DC or ICP problems use different interfaces (`ColdPlasma` drift-diffusion,
  ICP with magnetic fields); confirm the interface type name from an exported model or the COMSOL
  Programming Reference rather than guessing.
