import com.comsol.model.*;
import com.comsol.model.util.*;

/** Export a library model as Java, without solving. Set the .mph name; the file must be in /workspace. */
public class ExportModelJava {
  public static void main(String[] args) throws Exception {
    Model m = ModelUtil.load("Loaded", "positive_column_1d.mph");
    for (String c : m.component().tags())
      for (String p : m.component(c).physics().tags())
        System.out.println("PHYSICS " + c + "/" + p + " : " + m.component(c).physics(p).getType());
    for (String s : m.study().tags()) System.out.println("STUDY " + s + " : " + m.study(s).label());
    for (String r : m.result().tags()) System.out.println("PLOTGROUP " + r + " : " + m.result(r).label());
    System.out.println("SOLUTIONS " + String.join(",", m.sol().tags()));
    // Must be ./<name>.txt: the service does not return .java files.
    m.save("./model_export.txt", "java");
    System.out.println("RESULT_export=model_export.txt");
  }
}
