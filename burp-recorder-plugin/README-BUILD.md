BSTG Burp Recorder (fixed build)

Build:
  mvn clean package

Output:
  target/bstg-burp-recorder.jar

Why this build works:
- Montoya API is compile-time only (`provided`) and is not packaged into the final JAR.
- Gson is shaded into the final JAR.
- A service descriptor is included so Burp can discover the extension entry class.

Burp entry class:
  com.bstg.burp.recorder.BstgExtension
