# COMSOL REST API - Agent User Guide

## Overview

This is a REST API service that wraps COMSOL Multiphysics command-line functionality, designed specifically for AI Agent automation.

**Service URL**: `http://140.134.138.17:2035`
**API Version**: v1
**Base Path**: `/api/v1`

---

## System Limits

| Limit | Value | Description |
|-------|-------|-------------|
| Max upload size | 500 MB | Total size per job submission |
| Job timeout | 48 hours | Max execution time per job |
| Job retention | 30 days | Completed/failed jobs auto-deleted after this period |
| Concurrency | 1 | Jobs execute sequentially (FIFO queue) |

---

## Core Workflow

```
Generate .java code
       |
       v
POST /api/v1/batch (upload file)
       |
       v
   Get job_id
       |
       v
GET /api/v1/jobs/{job_id} (poll status)
       |
       v
   +---+---+
   |       |
Success  Failed
   |       |
   v       v
Download  Parse errors[] array
result         |
   |           v
   v      Fix code based on structured errors
Inspect        |
results        v
metadata  Resubmit (back to start)
```

---

## API Endpoints

### 1. Health Check

```
GET /api/v1/health
```

**Purpose**: Verify the service is running properly and check queue status before submitting jobs

**Response Example**:
```json
{
  "status": "healthy",
  "comsol_available": true,
  "queue_size": 2,
  "running_job": "job_abc123def456",
  "max_upload_size_mb": 500,
  "job_timeout_hours": 48
}
```

**Fields**:
- `status`: Service status
- `comsol_available`: Whether COMSOL executable exists
- `queue_size`: Number of tasks currently queued
- `running_job`: ID of the currently executing job, or `null` if idle
- `max_upload_size_mb`: Maximum upload size per job (MB)
- `job_timeout_hours`: Maximum execution time per job (hours)

**Agent Tip**: Check `queue_size` and `running_job` before submitting to estimate wait time. If `queue_size` is high, consider waiting before submitting.

---

### 2. System Information

```
GET /api/v1/info
```

**Purpose**: Get COMSOL version information

**Response Example**:
```json
{
  "comsol_version": "COMSOL Multiphysics 6.4.0.293",
  "comsol_path": "/usr/local/comsol64/multiphysics/bin/comsol",
  "api_version": "1.0.0"
}
```

---

### 3. Submit Batch Job (Primary Endpoint)

```
POST /api/v1/batch
Content-Type: multipart/form-data
```

**Purpose**: Upload .java / .mph / .class files for simulation, with optional data files

**Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `files` | file(s) | Yes | One main file (.java, .mph, or .class) and optional data files |
| `study` | string | No | Specify the study name to run |
| `parameters` | string (JSON) | No | Model parameters in JSON format |
| `owner` | string | No | Job owner identifier (for tracking) |

**curl Examples**:
```bash
# Basic usage (single file)
curl -X POST -F "files=@MyModel.java" http://140.134.138.17:2035/api/v1/batch

# With additional data files (multi-file upload)
curl -X POST \
  -F "files=@MyModel.java" \
  -F "files=@data.txt" \
  -F "files=@config.csv" \
  http://140.134.138.17:2035/api/v1/batch

# With parameters
curl -X POST \
  -F "files=@MyModel.java" \
  -F "study=std1" \
  -F 'parameters={"voltage": 10, "frequency": 1000}' \
  http://140.134.138.17:2035/api/v1/batch
```

**Multi-file Upload Notes**:
- Only ONE main file (.java, .mph, or .class) allowed per job
- Additional files (e.g., .txt, .csv) are saved in the same directory
- Data files can be referenced using relative paths in your Java code

**Response Example**:
```json
{
  "id": "job_abc123def456",
  "type": "batch",
  "status": "pending",
  "created_at": "2024-01-16T10:00:00.000000",
  "started_at": null,
  "finished_at": null,
  "exit_code": null,
  "error_message": null,
  "success": null,
  "duration_seconds": null,
  "output_files": [],
  "errors": [],
  "input_file": "MyModel.java",
  "study": null,
  "parameters": null,
  "owner": null,
  "queue_position": 3
}
```

**Response Fields**:
- `id`: Unique job identifier
- `type`: Job type (`batch` or `compile`)
- `status`: Current status (see status table below)
- `input_file`: Name of the uploaded main file
- `study`: Study name if specified
- `parameters`: Parameters dict if specified
- `owner`: Owner identifier if specified
- `queue_position`: Position in queue (1-based for pending, 0 for running, null otherwise)

**Important**: For .java files, the system automatically:
1. Compiles .java to .class
2. Executes .class for simulation

---

### 4. Submit Compile Job

```
POST /api/v1/compile
Content-Type: multipart/form-data
```

**Purpose**: Compile .java file only, without running simulation

**Parameters**:
| Parameter | Type | Required | Description |
|-----------|------|----------|-------------|
| `files` | file(s) | Yes | One .java file and optional data files |
| `owner` | string | No | Job owner identifier (for tracking) |

**curl Examples**:
```bash
# Single file
curl -X POST -F "files=@MyModel.java" http://140.134.138.17:2035/api/v1/compile

# With data files
curl -X POST \
  -F "files=@MyModel.java" \
  -F "files=@data.txt" \
  http://140.134.138.17:2035/api/v1/compile
```

**Use Case**: Validate code compiles successfully before running full simulation. Compilation typically completes in seconds, while batch runs can take minutes to hours.

---

### 5. Query Job Status (Key Endpoint)

```
GET /api/v1/jobs/{job_id}
```

**Purpose**: Get detailed job status and error information

**Success Response Example**:
```json
{
  "id": "job_abc123def456",
  "type": "batch",
  "status": "completed",
  "created_at": "2024-01-16T10:00:00.000000",
  "started_at": "2024-01-16T10:00:01.000000",
  "finished_at": "2024-01-16T10:05:32.000000",
  "exit_code": 0,
  "error_message": null,
  "success": true,
  "duration_seconds": 331.0,
  "output_files": ["MyModel_result.mph"],
  "errors": [],
  "input_file": "MyModel.java",
  "study": null,
  "parameters": null,
  "owner": null,
  "queue_position": null
}
```

**Failure Response Example (with structured errors)**:
```json
{
  "id": "job_xyz789",
  "type": "batch",
  "status": "failed",
  "created_at": "2024-01-16T11:00:00.000000",
  "started_at": "2024-01-16T11:00:01.000000",
  "finished_at": "2024-01-16T11:00:05.000000",
  "exit_code": 1,
  "error_message": "Compilation failed",
  "success": false,
  "duration_seconds": 4.0,
  "output_files": [],
  "errors": [
    {
      "error_type": "CompileError",
      "message": "cannot find symbol: variable voltage",
      "file": "MyModel.java",
      "line": 45,
      "column": null,
      "suggestion": "Variable or symbol 'voltage' is not defined. Check for typos or ensure it is declared."
    }
  ],
  "input_file": "MyModel.java",
  "study": null,
  "parameters": null,
  "owner": null,
  "queue_position": null
}
```

**Job Status Values**:
| Status | Description |
|--------|-------------|
| `pending` | Queued, waiting to execute |
| `running` | Currently executing |
| `completed` | Successfully completed |
| `failed` | Execution failed |
| `cancelled` | Cancelled by user |

**Error Types**:
| Type | Description |
|------|-------------|
| `CompileError` | Java compilation error |
| `RuntimeError` | COMSOL runtime error |
| `LicenseError` | License-related error |

---

### 6. List All Jobs

```
GET /api/v1/jobs?limit=100&offset=0
```

**Purpose**: Get list of all jobs (sorted by creation time, newest first)

**Parameters**:
| Parameter | Type | Default | Description |
|-----------|------|---------|-------------|
| `limit` | int | 100 | Maximum number to return |
| `offset` | int | 0 | Number to skip |

**Response Example**:
```json
{
  "jobs": [...],
  "total": 15
}
```

---

### 7. Cancel Job

```
POST /api/v1/jobs/{job_id}/cancel
```

**Purpose**: Cancel a pending or running job

**Note**: Only jobs with `pending` or `running` status can be cancelled. Running jobs are terminated via OS signals (SIGTERM, then SIGKILL).

**Success Response**:
```json
{
  "message": "Job cancelled",
  "id": "job_abc123",
  "status": "cancelled"
}
```

**Failure Response** (job already completed):
```json
{
  "detail": "Cannot cancel job with status: completed"
}
```

---

### 8. Delete Job

```
DELETE /api/v1/jobs/{job_id}
```

**Purpose**: Permanently delete a job and all associated files (uploads, results, logs)

**Note**: If the job is pending or running, it will be cancelled first before deletion.

**Success Response**:
```json
{
  "message": "Job deleted",
  "id": "job_abc123"
}
```

**Failure Response**:
```json
{
  "detail": "Job not found: job_abc123"
}
```

---

### 9. Get Full Log

```
GET /api/v1/jobs/{job_id}/log
```

**Purpose**: Get complete COMSOL output log for a job

**Response Example**:
```json
{
  "log": "=== COMSOL Compile & Run ===\nInput: /path/to/MyModel.java\n..."
}
```

**Use Case**: When `errors[]` is insufficient to diagnose the problem, check the raw log.

---

### 10. Real-time Log Stream (Server-Sent Events)

```
GET /api/v1/jobs/{job_id}/log/stream
```

**Purpose**: Watch job execution log in real-time

**curl Example**:
```bash
curl -N http://140.134.138.17:2035/api/v1/jobs/{job_id}/log/stream
```

**Event Format**:
```
data: Starting compilation...

data: Compiling MyModel.java...

data: Running simulation...

event: complete
data: completed
```

**Note**: When the job completes, an `event: complete` event is sent and the connection closes.

---

### 11. Get Result Metadata

```
GET /api/v1/jobs/{job_id}/results
```

**Purpose**: Get structured metadata from the result .mph file without downloading it

**Response Example**:
```json
{
  "model_info": {
    "title": "My Plasma Model",
    "description": "Argon plasma simulation",
    "comsol_version": "6.4.0.293",
    "computation_time": "331 s",
    "computation_date": "2024-01-16",
    "file_size": "5.4 MB"
  },
  "parameters": [
    {"name": "voltage", "value": "10 [V]"},
    {"name": "frequency", "value": "1000 [Hz]"}
  ],
  "studies": [
    {
      "label": "Study 1",
      "type": "Stationary",
      "settings": {}
    }
  ],
  "plot_groups": [
    {
      "tag": "pg1",
      "label": "Electric Potential",
      "type": "PlotGroup2D",
      "plots": [
        {
          "label": "Surface",
          "type": "Surface",
          "expr": "V",
          "unit": "V",
          "descr": "Electric potential"
        }
      ]
    }
  ],
  "has_thumbnail": true
}
```

**Agent Tip**: Use this endpoint after a successful job to inspect results (parameters, studies, plot groups) without downloading the full .mph file. This is useful to verify the simulation produced the expected outputs.

---

### 12. Get Result Thumbnail

```
GET /api/v1/jobs/{job_id}/results/thumbnail
```

**Purpose**: Get the model thumbnail image extracted from the result .mph file

**Response**: PNG image (`Content-Type: image/png`)

**Note**: Returns 404 if no thumbnail is available.

---

### 13. Download Results

```
GET /api/v1/jobs/{job_id}/download
```

**Purpose**: Download simulation result files

**Behavior**:
- Single file: Downloads the file directly (e.g., `result.mph`)
- Multiple files: Downloads as ZIP archive (e.g., `job_xxx_results.zip`)

**curl Example**:
```bash
# Use -OJ to preserve correct filename from server
curl -OJ http://140.134.138.17:2035/api/v1/jobs/{job_id}/download
```

**Important**: Use `-OJ` flags (not just `-O`) to get the correct filename:
- `-O` saves to a file
- `-J` uses the filename from Content-Disposition header

**Download Specific File**:
```
GET /api/v1/jobs/{job_id}/download/{filename}
```

```bash
curl -OJ http://140.134.138.17:2035/api/v1/jobs/{job_id}/download/result.mph
```

---

## Agent Best Practices

### 1. Pre-flight Check

Before submitting jobs, always check service health:

```python
health = requests.get(f"{API_BASE}/health").json()

if not health["comsol_available"]:
    # COMSOL not available, do not submit
    raise RuntimeError("COMSOL is not available")

if health["queue_size"] > 5:
    # Queue is busy, consider waiting or informing the user
    print(f"Warning: {health['queue_size']} jobs in queue")

if health["running_job"]:
    print(f"A job is currently running: {health['running_job']}")
```

### 2. Job Submission and Polling Strategy

```python
import requests
import time

API_BASE = "http://140.134.138.17:2035/api/v1"

def submit_and_wait(java_code: str, filename: str = "Model.java") -> dict:
    """Submit job and wait for completion"""

    # 1. Submit job
    files = {"files": (filename, java_code, "text/x-java")}
    response = requests.post(f"{API_BASE}/batch", files=files)
    job = response.json()
    job_id = job["id"]

    # 2. Poll until completion
    while True:
        status_response = requests.get(f"{API_BASE}/jobs/{job_id}")
        job = status_response.json()

        if job["status"] in ["completed", "failed", "cancelled"]:
            break

        time.sleep(2)  # Check every 2 seconds

    return job
```

### 3. Error Handling and Auto-correction

```python
def handle_job_result(job: dict) -> str:
    """Process job result, return fix suggestions or success message"""

    if job["success"]:
        return f"Simulation completed successfully! Output files: {job['output_files']}"

    # Parse structured errors
    errors = job.get("errors", [])

    if not errors:
        # No structured errors, check raw log
        log_response = requests.get(f"{API_BASE}/jobs/{job['id']}/log")
        return f"Job failed, raw log:\n{log_response.json()['log']}"

    # Handle by error type
    suggestions = []
    for error in errors:
        if error["error_type"] == "CompileError":
            suggestions.append(
                f"Compile error ({error['file']}:{error['line']}): "
                f"{error['message']}\n"
                f"Suggestion: {error.get('suggestion', 'Check code syntax')}"
            )
        elif error["error_type"] == "LicenseError":
            suggestions.append(
                f"License error: {error['message']}\n"
                f"Action: Wait 60 seconds and retry (license may be in use by another job)"
            )
        else:
            suggestions.append(
                f"Runtime error: {error['message']}\n"
                f"Suggestion: {error.get('suggestion', 'Check model configuration')}"
            )

    return "\n\n".join(suggestions)
```

### 4. Error Recovery Strategy

| Error Type | Strategy |
|------------|----------|
| `CompileError` | Fix the code based on `errors[].message`, `line`, and `suggestion`, then resubmit |
| `RuntimeError` | Check the raw log via `/jobs/{id}/log` for details, fix model configuration, then resubmit |
| `LicenseError` | Wait 60 seconds and retry (up to 3 times). If persistent, the license server may be down |
| No errors but failed | Check raw log — may be a timeout or system-level issue |

### 5. Java Code Naming Rules

**Important**: Java public class name must match the filename!

```java
// Filename: MyModel.java
// Class name must be MyModel
public class MyModel {
    public static void main(String[] args) {
        // ...
    }
}
```

### 6. Common Errors and Fixes

| Error Message | Cause | Fix |
|---------------|-------|-----|
| `cannot find symbol: variable xxx` | Variable not declared | Verify variable is declared or check spelling |
| `cannot find symbol: method xxx` | Incorrect method name | Check COMSOL API documentation for correct method name |
| `incompatible types` | Type mismatch | Check type casting or use correct method |
| `';' expected` | Missing semicolon | Add semicolon at end of statement |
| `License checkout failed` | License unavailable | Wait 60s and retry, or check license server |
| `public type X must be defined in its own file` | Class name doesn't match filename | Ensure class name matches filename |

### 7. Recommended Workflow

1. **Check service health**:
   ```
   GET /api/v1/health
   ```
   Verify `comsol_available` is true and check `queue_size`

2. **Compile first to validate** (optional but recommended):
   ```
   POST /api/v1/compile
   ```
   Quickly check for syntax errors (seconds vs minutes/hours for full run)

3. **Submit batch job**:
   ```
   POST /api/v1/batch
   ```

4. **Poll status** (recommended interval: 2-5 seconds):
   ```
   GET /api/v1/jobs/{job_id}
   ```
   Check `queue_position` to estimate wait time

5. **Process result**:
   - Success: Inspect metadata via `/jobs/{id}/results`, then download if needed
   - Failed: Parse `errors[]`, fix code, resubmit

---

## Complete Agent Example

```python
import requests
import time
from typing import Optional, Tuple

API_BASE = "http://140.134.138.17:2035/api/v1"

class COMSOLAgent:
    def __init__(self):
        self.api_base = API_BASE

    def check_health(self) -> dict:
        """Check service health and return full status"""
        try:
            r = requests.get(f"{self.api_base}/health", timeout=5)
            return r.json()
        except:
            return {"status": "unreachable", "comsol_available": False}

    def is_available(self) -> bool:
        """Check if service is available"""
        health = self.check_health()
        return health.get("status") == "healthy" and health.get("comsol_available", False)

    def submit_java(
        self,
        code: str,
        filename: str,
        study: Optional[str] = None,
        parameters: Optional[dict] = None,
        data_files: Optional[list] = None,
        owner: Optional[str] = None
    ) -> str:
        """Submit Java code, return job_id

        Args:
            code: Java source code
            filename: Java filename (must match public class name)
            study: Optional study name to run
            parameters: Optional model parameters dict
            data_files: Optional list of (filename, content) tuples for data files
            owner: Optional owner identifier for tracking
        """
        files = [("files", (filename, code, "text/x-java"))]

        # Add additional data files if provided
        if data_files:
            for data_filename, data_content in data_files:
                files.append(("files", (data_filename, data_content, "application/octet-stream")))

        data = {}
        if study:
            data["study"] = study
        if parameters:
            import json
            data["parameters"] = json.dumps(parameters)
        if owner:
            data["owner"] = owner

        r = requests.post(
            f"{self.api_base}/batch",
            files=files,
            data=data
        )
        return r.json()["id"]

    def wait_for_completion(
        self,
        job_id: str,
        poll_interval: float = 2.0,
        timeout: float = 3600.0
    ) -> dict:
        """Wait for job completion, return final status"""
        start_time = time.time()

        while True:
            if time.time() - start_time > timeout:
                raise TimeoutError(f"Job {job_id} timed out")

            r = requests.get(f"{self.api_base}/jobs/{job_id}")
            job = r.json()

            if job["status"] in ["completed", "failed", "cancelled"]:
                return job

            time.sleep(poll_interval)

    def get_errors(self, job: dict) -> list:
        """Extract structured error list"""
        return job.get("errors", [])

    def get_raw_log(self, job_id: str) -> str:
        """Get raw log"""
        r = requests.get(f"{self.api_base}/jobs/{job_id}/log")
        return r.json().get("log", "")

    def get_result_metadata(self, job_id: str) -> dict:
        """Get result metadata without downloading the full file"""
        r = requests.get(f"{self.api_base}/jobs/{job_id}/results")
        if r.status_code == 200:
            return r.json()
        return {}

    def cancel_job(self, job_id: str) -> bool:
        """Cancel a pending or running job"""
        r = requests.post(f"{self.api_base}/jobs/{job_id}/cancel")
        return r.status_code == 200

    def delete_job(self, job_id: str) -> bool:
        """Delete a job and all its files"""
        r = requests.delete(f"{self.api_base}/jobs/{job_id}")
        return r.status_code == 200

    def download_result(self, job_id: str, save_path: str) -> bool:
        """Download result file"""
        r = requests.get(
            f"{self.api_base}/jobs/{job_id}/download",
            stream=True
        )
        if r.status_code == 200:
            with open(save_path, "wb") as f:
                for chunk in r.iter_content(chunk_size=8192):
                    f.write(chunk)
            return True
        return False

    def run_simulation(
        self,
        code: str,
        filename: str = "Model.java"
    ) -> Tuple[bool, dict]:
        """
        Execute complete simulation workflow
        Returns: (success, job_details)
        """
        # Ensure class name matches filename
        class_name = filename.replace(".java", "")
        if f"public class {class_name}" not in code:
            raise ValueError(
                f"Class name must match filename. "
                f"Expected 'public class {class_name}'"
            )

        # Submit and wait
        job_id = self.submit_java(code, filename)
        job = self.wait_for_completion(job_id)

        return job.get("success", False), job


# Usage Example
if __name__ == "__main__":
    agent = COMSOLAgent()

    if not agent.is_available():
        print("COMSOL API service unavailable")
        exit(1)

    java_code = '''
import com.comsol.model.*;
import com.comsol.model.util.*;

public class SimpleModel {
    public static void main(String[] args) {
        Model model = ModelUtil.create("Model");
        model.label("Simple Test Model");

        // Create geometry
        model.component().create("comp1", true);
        model.component("comp1").geom().create("geom1", 2);
        model.component("comp1").geom("geom1").create("r1", "Rectangle");
        model.component("comp1").geom("geom1").feature("r1")
            .set("size", new double[]{1, 0.5});
        model.component("comp1").geom("geom1").run();

        // Create mesh
        model.component("comp1").mesh().create("mesh1");
        model.component("comp1").mesh("mesh1").autoMeshSize(5);
        model.component("comp1").mesh("mesh1").run();

        System.out.println("Model created successfully!");
        model.save("simple_result");
    }
}
'''

    success, job = agent.run_simulation(java_code, "SimpleModel.java")

    if success:
        print(f"Simulation successful! Output: {job['output_files']}")

        # Inspect result metadata before downloading
        metadata = agent.get_result_metadata(job["id"])
        if metadata:
            print(f"Model: {metadata.get('model_info', {}).get('title', 'N/A')}")
            print(f"Studies: {len(metadata.get('studies', []))}")
            print(f"Plot groups: {len(metadata.get('plot_groups', []))}")

        agent.download_result(job["id"], "result.mph")
    else:
        print("Simulation failed, error details:")
        for error in agent.get_errors(job):
            print(f"  - [{error['error_type']}] {error['message']}")
            if error.get("line"):
                print(f"    Location: {error['file']}:{error['line']}")
            if error.get("suggestion"):
                print(f"    Suggestion: {error['suggestion']}")

        # Check raw log if no structured errors
        if not agent.get_errors(job):
            print("\nRaw log:")
            print(agent.get_raw_log(job["id"]))
```

---

## Field Notes: Trial-and-Error Log (verified against the live service)

These notes come from a real end-to-end run (2D Laplace demo, COMSOL 6.4.0.293, 2026-10-27).
It took four batch submissions before the numbers were correct. Each entry gives the symptom,
the cause and the fix.

### A. Job status can be misleading

`status: completed` and `success: true` do NOT guarantee the model ran correctly.
If the Java code throws inside the COMSOL run, the service may still report success.
Attempts 1, 2 and 3 below all showed `completed / success: true` while the log contained errors
or the numbers were wrong.

Always do all of the following after a job finishes:
1. Fetch `/jobs/{id}/log` and search it for `Error`, `Exception` and `NaN`.
2. Have the Java code print key results (for example `System.out.println("RESULT_X=" + value)`) and read them from the log.
3. Compare them with an analytic value or a simple sanity check.
4. Check `/jobs/{id}/results`: empty `plot_groups` means no plots were created.

```python
def log_has_problem(log: str) -> bool:
    bad = ["/*****Error", "Error running java class", "Exception", "NaN"]
    return any(b in log for b in bad)
```

### B. The four attempts

| # | Result | Symptom | Cause | Fix |
|---|--------|---------|-------|-----|
| 0 | `/compile` failed | `Unhandled exception type IOException` at `model.save(...)` | `model.save()` throws a checked exception | Declare `public static void main(String[] args) throws java.io.IOException` |
| 1 | batch `completed`, wrong numbers | `RESULT_AVG_U=0.0`, `RESULT_MAX_U=NaN` | Numerical results (`AvSurface`, `MaxSurface`) had no dataset and no selection | Add `.set("data", "dset1")` and `.selection().all()` before reading `getReal()` |
| 2 | batch `completed`, wrong numbers | avg = 7.35 (expected 5), max = 10.6 (expected 10) | Boundaries chosen by hard-coded numbers (`selection().set(1)` / `set(2)`) were not the left and right edges, so the Dirichlet conditions landed on the wrong boundaries | Select boundaries by coordinates (see C) and print the number of selected entities |
| 3 | batch `completed` but the log shows an error | `A matrix of size 1x1 expected. - Parameter: Diffusion coefficient (c)` | The `c` coefficient was set as a 2x2 array in a scalar problem | Use `new String[][]{{"1"}}` for a scalar `u` |
| 4 | correct | avg = 5.000000000002, max = 10.000000000000 (analytic 5 and 10) | none | final code |

Only attempt 4 (`job_3810088d6b38`) is a valid result.

### C. Code patterns that worked

Use a `Box` selection instead of boundary numbers (the numbering is not reliable):

```java
model.component("comp1").selection().create("boxL", "Box");
model.component("comp1").selection("boxL").set("entitydim", 1);
model.component("comp1").selection("boxL").set("xmin", -1e-6);
model.component("comp1").selection("boxL").set("xmax", 1e-6);
model.component("comp1").selection("boxL").set("ymin", -1);
model.component("comp1").selection("boxL").set("ymax", 1);
model.component("comp1").selection("boxL").set("condition", "inside");
// then: physics("c").feature("dir1").selection().named("boxL");
System.out.println("NBND_L=" + model.component("comp1").selection("boxL").entities(1).length); // expect 1
```

Read numerical results inside the Java code:

```java
model.result().numerical().create("av1", "AvSurface");
model.result().numerical("av1").set("data", "dset1");
model.result().numerical("av1").selection().all();
model.result().numerical("av1").set("expr", new String[]{"u"});
double avg = model.result().numerical("av1").getReal()[0][0];
System.out.println("RESULT_AVG_U=" + avg);
```

### D. Practical observations

- `/compile` only checks syntax and typing. It cannot catch runtime errors such as the wrong matrix size or wrong selections, which only appear in `/batch`.
- A small model finishes in about 10 s total (most of that is COMSOL startup and model saving). Use `/compile` first and keep test models small.
- Output files are named `<name>_result_Model.mph`. The `.mph.status` file is not a model. Download the real one with `/jobs/{id}/download/<name>_result_Model.mph`.
- `/jobs/{id}/results/thumbnail` returns a small JSON error (not a PNG) when the model has no plot group or was generated in batch. Export images with an `Image` node instead (see E).
- Printing selection counts and key numbers from Java is the cheapest way to find mistakes. The raw log is the main debugging tool, so read `/jobs/{id}/log`.
- The Plasma Module licence on this server has NOT been verified. The demo only used the Coefficient Form PDE interface, which is in the base package.

### E. Figures and exported files (service update 2026-11-03)

The service now runs `comsol batch -3drend sw ...` (software OpenGL, required on this headless server) and,
after each batch run, copies **every new file in the job's working directory** into the result directory.
The working directory is the upload directory, so COMSOL export nodes with relative file names come back
in `output_files` and through `/download`:

```java
// native COMSOL figure: title, axes and colour legend
model.result("pg1").run();
model.result().export().create("img1", "Image");
model.result().export("img1").set("plotgroup", "pg1");      // "plotgroup", not "sourceobject"
model.result().export("img1").set("filename", "./potential.png");
model.result().export("img1").set("size", "manualweb");
model.result().export("img1").set("width", "1200");
model.result().export("img1").set("height", "900");
model.result().export("img1").set("options", "on");
model.result().export("img1").set("title", "on");
model.result().export("img1").set("legend", "on");
model.result().export("img1").set("axes", "on");
model.result().export("img1").set("logo", "off");
model.result().export("img1").run();
```

`Data` exports (`set("filename", "./field.txt")`) and `Plot` exports work the same way. The log shows
`--- Exported files collected: ... ---` with the returned names.

Verified: `Surface`, `Contour`, `ArrowSurface` (2D plot groups) and `LineGraph` on a `CutLine2D` dataset
(1D plot group) render correctly at 1200x900. Without `-3drend sw` the Image export reported no error but
wrote no file; with `"sourceobject"` instead of `"plotgroup"` and without the options above, images had no
axes, title or legend.

Post-processing a previous result without re-solving: send a `.java` program together with the result
`.mph`. When a `.java`/`.class` is present it is the main file and every `.mph` in the same submission is a
data file (service update 2026-11-03), so the program can load it:

```java
Model model = ModelUtil.load("Loaded", "MyModel_result_Model.mph");   // bare file name
// list model.result().tags() / model.result().dataset().tags(), evaluate, export images
```

`curl -X POST -F "files=@PostProcess.java" -F "files=@MyModel_result_Model.mph" .../api/v1/batch`
(verified: a small model loads in about 4.5 s and nothing is re-solved). Numerical features on the loaded
model need `set("data", ...)` and `selection().all()`, otherwise they return NaN or 0. Sending only `.mph`
files (no program) still requires exactly one `.mph`, which is run as the main model.

Restrictions that remain: Java code cannot read or write files itself, read system properties
(`user.dir`) or call `getProtectionDomain` (COMSOL security preferences). Every model created with
`ModelUtil.create(...)` is saved as `<class>_result_<tag>.mph`. `/jobs/{id}/results/thumbnail` returns 404
for batch-generated models (they carry no thumbnail); use exported images instead.

---

## Important Notes

1. **Job Queue**: Multiple jobs execute sequentially (FIFO), no parallel execution
2. **No Authentication**: API requires no authentication, ensure network security
3. **Filename Restrictions**: Java file class name must match filename
4. **License Limitations**: COMSOL license may limit concurrent job execution
5. **Job Timeout**: Jobs are automatically killed after 48 hours
6. **Auto-Cleanup**: Completed/failed/cancelled jobs and their files are automatically deleted after 30 days
7. **Server Restart**: If the server restarts, any running or pending jobs will be marked as failed

---

## Quick Reference

```bash
# Health check
curl http://140.134.138.17:2035/api/v1/health

# Submit Java file (single file)
curl -X POST -F "files=@Model.java" http://140.134.138.17:2035/api/v1/batch

# Submit with data files (multi-file)
curl -X POST \
  -F "files=@Model.java" \
  -F "files=@data.txt" \
  http://140.134.138.17:2035/api/v1/batch

# Compile only (validate syntax)
curl -X POST -F "files=@Model.java" http://140.134.138.17:2035/api/v1/compile

# Query status
curl http://140.134.138.17:2035/api/v1/jobs/{job_id}

# View log
curl http://140.134.138.17:2035/api/v1/jobs/{job_id}/log

# Real-time log
curl -N http://140.134.138.17:2035/api/v1/jobs/{job_id}/log/stream

# Result metadata (without downloading)
curl http://140.134.138.17:2035/api/v1/jobs/{job_id}/results

# Result thumbnail
curl -o thumbnail.png http://140.134.138.17:2035/api/v1/jobs/{job_id}/results/thumbnail

# Download result (use -OJ to preserve filename)
curl -OJ http://140.134.138.17:2035/api/v1/jobs/{job_id}/download

# Download specific file
curl -OJ http://140.134.138.17:2035/api/v1/jobs/{job_id}/download/result.mph

# Cancel a job
curl -X POST http://140.134.138.17:2035/api/v1/jobs/{job_id}/cancel

# Delete a job
curl -X DELETE http://140.134.138.17:2035/api/v1/jobs/{job_id}
```
