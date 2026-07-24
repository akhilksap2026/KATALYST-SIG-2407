import os
import json
from datetime import datetime
from typing import Optional

import psycopg2
import psycopg2.extras
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
import uvicorn

from contextlib import asynccontextmanager

DATABASE_URL = os.environ.get("DATABASE_URL")
SCHEMA_FILE = os.path.join(os.path.dirname(os.path.abspath(__file__)), "schema.sql")


def get_conn():
    return psycopg2.connect(DATABASE_URL, cursor_factory=psycopg2.extras.RealDictCursor)


def bootstrap_schema():
    """Create all tables if they do not already exist (idempotent, uses schema.sql)."""
    with open(SCHEMA_FILE) as f:
        sql = f.read()
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(sql)
        conn.commit()
    print("[Catalyst] Schema bootstrap complete.")


def maybe_seed():
    """Seed initial data if the agents table is empty."""
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT COUNT(*) FROM agents")
            count = cur.fetchone()["count"]
    if count == 0:
        print("[Catalyst] Empty database — running seed...")
        import seed as seed_module
        seed_module.seed()
    else:
        print(f"[Catalyst] Database already has {count} agent(s) — skipping seed.")


@asynccontextmanager
async def lifespan(app):
    bootstrap_schema()
    maybe_seed()
    yield


app = FastAPI(title="Catalyst API", lifespan=lifespan)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


# ── Agents ────────────────────────────────────────────────────────────────────

@app.get("/api/agents")
def list_agents():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM agents ORDER BY gx, gy")
            rows = cur.fetchall()
    return [dict(r) for r in rows]


class AgentUpdate(BaseModel):
    name: Optional[str] = None
    priority: Optional[str] = None
    health: Optional[str] = None
    success: Optional[float] = None
    conditions: Optional[list] = None
    actions: Optional[list] = None
    reads: Optional[list] = None
    writes: Optional[list] = None
    version: Optional[str] = None


@app.patch("/api/agents/{agent_id}")
def update_agent(agent_id: str, body: AgentUpdate):
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(400, "No fields to update")
    set_clause = ", ".join(
        f"{k} = %s" if not isinstance(v, (list, dict)) else f"{k} = %s::jsonb"
        for k, v in fields.items()
    )
    values = [
        json.dumps(v) if isinstance(v, (list, dict)) else v
        for v in fields.values()
    ]
    values.append(agent_id)
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE agents SET {set_clause}, updated_at = NOW() WHERE id = %s RETURNING *",
                values,
            )
            row = cur.fetchone()
        conn.commit()
    if not row:
        raise HTTPException(404, "Agent not found")
    return dict(row)


# ── Workflow edges ─────────────────────────────────────────────────────────────

@app.get("/api/workflow-edges")
def list_workflow_edges():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT from_agent, to_agent, edge_type FROM workflow_edges ORDER BY id")
            rows = cur.fetchall()
    return [dict(r) for r in rows]


# ── Conflicts ─────────────────────────────────────────────────────────────────

@app.get("/api/conflicts")
def list_conflicts():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM conflicts ORDER BY CASE severity WHEN 'critical' THEN 0 ELSE 1 END, id")
            rows = cur.fetchall()
    return [dict(r) for r in rows]


class ConflictStatusUpdate(BaseModel):
    status: str
    acknowledged_by: Optional[str] = None


@app.patch("/api/conflicts/{conflict_id}")
def update_conflict(conflict_id: str, body: ConflictStatusUpdate):
    with get_conn() as conn:
        with conn.cursor() as cur:
            if body.status == "resolved":
                cur.execute(
                    "UPDATE conflicts SET status=%s, acknowledged_by=%s, resolved_at=NOW() WHERE id=%s RETURNING *",
                    (body.status, body.acknowledged_by, conflict_id),
                )
            else:
                cur.execute(
                    "UPDATE conflicts SET status=%s, acknowledged_by=%s WHERE id=%s RETURNING *",
                    (body.status, body.acknowledged_by, conflict_id),
                )
            row = cur.fetchone()
        conn.commit()
    if not row:
        raise HTTPException(404, "Conflict not found")
    return dict(row)


# ── Audit log ─────────────────────────────────────────────────────────────────

@app.get("/api/audit-log")
def list_audit_log():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM audit_log ORDER BY id DESC")
            rows = cur.fetchall()
    return [dict(r) for r in rows]


class AuditLogEntry(BaseModel):
    time: str
    username: str
    action: str
    target: str
    env: str
    result: str
    tone: str
    note: Optional[str] = None


@app.post("/api/audit-log")
def create_audit_log(entry: AuditLogEntry):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "INSERT INTO audit_log (time, username, action, target, env, result, tone, note) VALUES (%s,%s,%s,%s,%s,%s,%s,%s) RETURNING *",
                (entry.time, entry.username, entry.action, entry.target, entry.env, entry.result, entry.tone, entry.note),
            )
            row = cur.fetchone()
        conn.commit()
    return dict(row)


# ── Jobs / Process Health ─────────────────────────────────────────────────────

@app.get("/api/jobs")
def list_jobs():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM jobs ORDER BY id")
            rows = cur.fetchall()
    return [dict(r) for r in rows]


class JobUpdate(BaseModel):
    health: Optional[str] = None
    last_run: Optional[str] = None
    duration: Optional[str] = None
    trend: Optional[str] = None


@app.patch("/api/jobs/{job_id}")
def update_job(job_id: str, body: JobUpdate):
    fields = {k: v for k, v in body.model_dump().items() if v is not None}
    if not fields:
        raise HTTPException(400, "No fields to update")
    set_clause = ", ".join(f"{k} = %s" for k in fields)
    values = list(fields.values()) + [job_id]
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                f"UPDATE jobs SET {set_clause}, updated_at = NOW() WHERE id = %s RETURNING *",
                values,
            )
            row = cur.fetchone()
        conn.commit()
    if not row:
        raise HTTPException(404, "Job not found")
    return dict(row)


# ── Trace runs ────────────────────────────────────────────────────────────────

@app.get("/api/trace")
def list_traces():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM trace_runs ORDER BY id DESC")
            rows = cur.fetchall()
    return [dict(r) for r in rows]


@app.get("/api/trace/{agent_id}")
def get_trace(agent_id: str):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT * FROM trace_runs WHERE agent_id = %s ORDER BY id DESC LIMIT 1",
                (agent_id,),
            )
            row = cur.fetchone()
    if not row:
        raise HTTPException(404, "Trace not found")
    return dict(row)


# ── Live events ───────────────────────────────────────────────────────────────

@app.get("/api/live-events")
def list_live_events():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM live_events ORDER BY id ASC")
            rows = cur.fetchall()
    return [dict(r) for r in rows]


# ── Agent diffs ───────────────────────────────────────────────────────────────

@app.get("/api/agent-diffs")
def list_agent_diffs():
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute("SELECT * FROM agent_diffs ORDER BY id")
            rows = cur.fetchall()
    return [dict(r) for r in rows]


# ── Tests ─────────────────────────────────────────────────────────────────────

@app.get("/api/tests/{agent_id}")
def get_tests(agent_id: str):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "SELECT * FROM agent_tests WHERE agent_id = %s ORDER BY id",
                (agent_id,),
            )
            rows = cur.fetchall()
    return [dict(r) for r in rows]


class TestResultUpdate(BaseModel):
    result: str
    got: Optional[str] = None


@app.patch("/api/tests/{test_id}")
def update_test(test_id: str, body: TestResultUpdate):
    with get_conn() as conn:
        with conn.cursor() as cur:
            cur.execute(
                "UPDATE agent_tests SET result=%s, got=%s WHERE id=%s RETURNING *",
                (body.result, body.got, test_id),
            )
            row = cur.fetchone()
        conn.commit()
    if not row:
        raise HTTPException(404, "Test not found")
    return dict(row)


# ── Static files ──────────────────────────────────────────────────────────────

BASE_DIR = os.path.dirname(os.path.abspath(__file__))


@app.get("/")
def root():
    return FileResponse(os.path.join(BASE_DIR, "Catalyst.dc.html"))


@app.get("/Catalyst.dc.html")
def catalyst():
    return FileResponse(os.path.join(BASE_DIR, "Catalyst.dc.html"))


@app.get("/support.js")
def support_js():
    return FileResponse(os.path.join(BASE_DIR, "support.js"))


if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=5000)
