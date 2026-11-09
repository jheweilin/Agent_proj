import com.comsol.model.*;
import com.comsol.model.util.*;

public class PostProcess {
  public static void main(String[] args) throws Exception {
    long t0 = System.currentTimeMillis();
    Model model = ModelUtil.load("Loaded", "PlotDataDemo_result_Model.mph");
    System.out.println("LOADED in " + (System.currentTimeMillis() - t0) + " ms");
    for (String t : model.result().tags()) System.out.println("PLOTGROUP " + t + " : " + model.result(t).label());
    for (String t : model.result().dataset().tags()) System.out.println("DATASET " + t);
    for (String t : model.param().varnames()) System.out.println("PARAM " + t + " = " + model.param().get(t));
    // new numbers from the stored solution, no re-solve
    model.result().numerical().create("mx", "MaxSurface");
    model.result().numerical("mx").set("data", "dset1");
    model.result().numerical("mx").set("expr", new String[]{"es.normE"});
    model.result().numerical("mx").selection().all();
    System.out.println("RESULT_max_normE=" + model.result().numerical("mx").getReal()[0][0]);
    model.result().numerical().create("av", "AvSurface");
    model.result().numerical("av").set("data", "dset1");
    model.result().numerical("av").set("expr", new String[]{"V"});
    model.result().numerical("av").selection().all();
    System.out.println("RESULT_avg_V=" + model.result().numerical("av").getReal()[0][0]);
    // a new figure that was not in the original job
    model.result().create("pgnew", "PlotGroup2D");
    model.result("pgnew").set("data", "dset1");
    model.result("pgnew").create("surf1", "Surface");
    model.result("pgnew").feature("surf1").set("expr", "es.Ey");
    model.result("pgnew").create("str1", "Streamline");
    model.result("pgnew").feature("str1").set("expr", new String[]{"es.Ex", "es.Ey"});
    model.result("pgnew").run();
    model.result().export().create("img", "Image");
    model.result().export("img").set("plotgroup", "pgnew");
    model.result().export("img").set("filename", "./Ey_streamlines.png");
    model.result().export("img").set("size", "manualweb");
    model.result().export("img").set("width", "1200");
    model.result().export("img").set("height", "900");
    model.result().export("img").set("options", "on");
    model.result().export("img").set("title", "on");
    model.result().export("img").set("legend", "on");
    model.result().export("img").set("axes", "on");
    model.result().export("img").run();
    System.out.println("TOTAL " + (System.currentTimeMillis() - t0) + " ms");
  }
}
