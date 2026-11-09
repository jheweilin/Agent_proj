import com.comsol.model.*;
import com.comsol.model.util.*;

/**
 * Demo of the platform's data-block convention: values printed between
 * "#PA_DATA_BEGIN ..." and "#PA_DATA_END" in the job log are turned into CSV files
 * and quick-look plots automatically when the job finishes.
 *
 * Two ways to get results out (copy the static helpers you need into your own model class):
 *  - exportImage: COMSOL renders a plot group to ./<file>.png (native COMSOL figure). The service runs
 *    batch with -3drend sw and returns every file the model writes to its working directory (since 2026-11-03).
 *  - dumpGrid2D / dumpLine / dumpTable: numbers printed into the log between #PA_DATA markers; the platform
 *    turns them into CSV files + quick-look plots and reports min/max/mean for checking.
 * Java code itself cannot read or write files (service security settings); COMSOL export nodes can.
 */
public class PlotDataDemo {

  /** Render a plot group with COMSOL to ./<file> (png), with title, axes and colour legend. */
  static void exportImage(Model model, String plotGroup, String file, int width, int height) {
    String tag = "pa_img_" + file.replaceAll("[^A-Za-z0-9]", "_");
    model.result(plotGroup).run();
    model.result().export().create(tag, "Image");
    model.result().export(tag).set("plotgroup", plotGroup);
    model.result().export(tag).set("filename", "./" + file);
    model.result().export(tag).set("size", "manualweb");
    model.result().export(tag).set("width", String.valueOf(width));
    model.result().export(tag).set("height", String.valueOf(height));
    model.result().export(tag).set("options", "on");
    model.result().export(tag).set("title", "on");
    model.result().export(tag).set("legend", "on");
    model.result().export(tag).set("axes", "on");
    model.result().export(tag).set("logo", "off");
    model.result().export(tag).run();
  }

  /** Values of `expr` on an nx-by-ny regular grid over [x0,x1]x[y0,y1] (use r,z for axisymmetric). Points outside the geometry come out as NaN. */
  static void dumpGrid2D(Model model, String name, String dset, String expr, String unit,
                         double x0, double x1, int nx, double y0, double y1, int ny) {
    double[][] c = new double[2][nx * ny];
    int k = 0;
    for (int j = 0; j < ny; j++)
      for (int i = 0; i < nx; i++) {
        c[0][k] = x0 + (x1 - x0) * i / (nx - 1);
        c[1][k] = y0 + (y1 - y0) * j / (ny - 1);
        k++;
      }
    String tag = "pa_" + name;
    model.result().numerical().create(tag, "Interp");
    model.result().numerical(tag).set("data", dset);
    model.result().numerical(tag).set("expr", expr);
    model.result().numerical(tag).set("coord", c);
    double[][] v = model.result().numerical(tag).getReal();
    System.out.println("#PA_DATA_BEGIN name=" + name + " kind=grid2d nx=" + nx + " ny=" + ny + " unit=" + unit + " cols=x,y," + name);
    for (int p = 0; p < nx * ny; p++) System.out.println(c[0][p] + "," + c[1][p] + "," + v[p][0]);
    System.out.println("#PA_DATA_END");
  }

  /** Values of `expr` at n points on the straight line (xa,ya) -> (xb,yb); first column is the arc length. */
  static void dumpLine(Model model, String name, String dset, String expr, String unit,
                       double xa, double ya, double xb, double yb, int n) {
    double[][] c = new double[2][n];
    for (int i = 0; i < n; i++) {
      c[0][i] = xa + (xb - xa) * i / (n - 1);
      c[1][i] = ya + (yb - ya) * i / (n - 1);
    }
    String tag = "pa_" + name;
    model.result().numerical().create(tag, "Interp");
    model.result().numerical(tag).set("data", dset);
    model.result().numerical(tag).set("expr", expr);
    model.result().numerical(tag).set("coord", c);
    double[][] v = model.result().numerical(tag).getReal();
    double len = Math.hypot(xb - xa, yb - ya);
    System.out.println("#PA_DATA_BEGIN name=" + name + " kind=line unit=" + unit + " cols=s,x,y," + name);
    for (int i = 0; i < n; i++) System.out.println((len * i / (n - 1)) + "," + c[0][i] + "," + c[1][i] + "," + v[i][0]);
    System.out.println("#PA_DATA_END");
  }

  /** Any table you compute yourself (e.g. a parameter sweep): first column is the x axis of the plot. */
  static void dumpTable(String name, String[] cols, double[][] rows) {
    System.out.println("#PA_DATA_BEGIN name=" + name + " kind=table cols=" + String.join(",", cols));
    for (double[] r : rows) {
      StringBuilder sb = new StringBuilder();
      for (int i = 0; i < r.length; i++) { if (i > 0) sb.append(','); sb.append(r[i]); }
      System.out.println(sb);
    }
    System.out.println("#PA_DATA_END");
  }

  public static void main(String[] args) throws java.io.IOException {
    Model model = ModelUtil.create("Model");
    model.component().create("comp1", true);
    model.component("comp1").geom().create("geom1", 2);
    model.component("comp1").geom("geom1").create("r1", "Rectangle");
    model.component("comp1").geom("geom1").feature("r1").set("size", new double[]{0.01, 0.01});
    model.component("comp1").geom("geom1").create("c1", "Circle");
    model.component("comp1").geom("geom1").feature("c1").set("r", 0.002);
    model.component("comp1").geom("geom1").feature("c1").set("pos", new double[]{0.005, 0.005});
    model.component("comp1").geom("geom1").create("dif1", "Difference");
    model.component("comp1").geom("geom1").feature("dif1").selection("input").set("r1");
    model.component("comp1").geom("geom1").feature("dif1").selection("input2").set("c1");
    model.component("comp1").geom("geom1").run();
    model.component("comp1").physics().create("es", "Electrostatics", "geom1");
    // left edge 100 V, right edge ground, hole = floating conductor (zero charge default)
    model.component("comp1").selection().create("bl", "Box");
    model.component("comp1").selection("bl").set("entitydim", 1);
    model.component("comp1").selection("bl").set("xmin", -1e-6);
    model.component("comp1").selection("bl").set("xmax", 1e-6);
    model.component("comp1").selection("bl").set("ymin", -1);
    model.component("comp1").selection("bl").set("ymax", 1);
    model.component("comp1").selection("bl").set("condition", "inside");
    model.component("comp1").selection().create("br", "Box");
    model.component("comp1").selection("br").set("entitydim", 1);
    model.component("comp1").selection("br").set("xmin", 0.01 - 1e-6);
    model.component("comp1").selection("br").set("xmax", 0.01 + 1e-6);
    model.component("comp1").selection("br").set("ymin", -1);
    model.component("comp1").selection("br").set("ymax", 1);
    model.component("comp1").selection("br").set("condition", "inside");
    model.component("comp1").physics("es").create("pot1", "ElectricPotential", 1);
    model.component("comp1").physics("es").feature("pot1").selection().named("bl");
    model.component("comp1").physics("es").feature("pot1").set("V0", "100[V]");
    model.component("comp1").physics("es").create("gnd1", "Ground", 1);
    model.component("comp1").physics("es").feature("gnd1").selection().named("br");
    model.component("comp1").mesh().create("mesh1");
    model.component("comp1").mesh("mesh1").autoMeshSize(4);
    model.component("comp1").mesh("mesh1").run();
    model.study().create("std1");
    model.study("std1").create("stat", "Stationary");
    model.study("std1").run();

    // --- native COMSOL figures ---
    model.result().create("pg1", "PlotGroup2D");
    model.result("pg1").set("data", "dset1");
    model.result("pg1").label("Electric potential");
    model.result("pg1").create("surf1", "Surface");
    model.result("pg1").feature("surf1").set("expr", "V");
    model.result("pg1").create("con1", "Contour");
    model.result("pg1").feature("con1").set("expr", "V");
    model.result("pg1").feature("con1").set("number", 12);
    model.result("pg1").feature("con1").set("coloring", "uniform");
    model.result("pg1").feature("con1").set("color", "white");
    exportImage(model, "pg1", "potential.png", 1200, 900);

    model.result().create("pg2", "PlotGroup2D");
    model.result("pg2").set("data", "dset1");
    model.result("pg2").label("Electric field norm");
    model.result("pg2").create("surf1", "Surface");
    model.result("pg2").feature("surf1").set("expr", "es.normE");
    model.result("pg2").create("arws1", "ArrowSurface");
    model.result("pg2").feature("arws1").set("expr", new String[]{"es.Ex", "es.Ey"});
    model.result("pg2").feature("arws1").set("color", "white");
    exportImage(model, "pg2", "efield.png", 1200, 900);

    model.result().dataset().create("cln1", "CutLine2D");
    model.result().dataset("cln1").setIndex("genpoints", 0, 0, 0);
    model.result().dataset("cln1").setIndex("genpoints", 0.005, 0, 1);
    model.result().dataset("cln1").setIndex("genpoints", 0.01, 1, 0);
    model.result().dataset("cln1").setIndex("genpoints", 0.005, 1, 1);
    model.result().create("pg3", "PlotGroup1D");
    model.result("pg3").set("data", "cln1");
    model.result("pg3").label("Potential along y = 5 mm");
    model.result("pg3").create("lngr1", "LineGraph");
    model.result("pg3").feature("lngr1").set("expr", "V");
    model.result("pg3").feature("lngr1").set("xdata", "expr");
    model.result("pg3").feature("lngr1").set("xdataexpr", "x");
    exportImage(model, "pg3", "potential_line.png", 1200, 800);

    // --- numbers for checking (CSV + quick-look plots made by the platform) ---
    dumpGrid2D(model, "V", "dset1", "V", "V", 0, 0.01, 81, 0, 0.01, 81);
    dumpGrid2D(model, "normE", "dset1", "es.normE", "V/m", 0, 0.01, 81, 0, 0.01, 81);
    dumpLine(model, "V_midline", "dset1", "V", "V", 0, 0.005, 0.01, 0.005, 101);
    dumpTable("check", new String[]{"quantity", "value"}, new double[][]{{1, 100}, {2, 0}});
  }
}
