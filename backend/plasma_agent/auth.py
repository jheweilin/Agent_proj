"""Password hashing and JWT bearer auth."""
from __future__ import annotations

import uuid
from datetime import datetime, timedelta, timezone

import bcrypt
import jwt
from fastapi import Depends, HTTPException, Query, Request
from sqlalchemy.ext.asyncio import AsyncSession

from .config import settings
from .db import User, get_session


def is_admin_email(email: str) -> bool:
    return (email or "").strip().lower() in settings.admin_emails


def is_faculty_email(email: str) -> bool:
    return (email or "").strip().lower() in settings.faculty_emails


def identity_flags(user: User) -> dict:
    """Admin/faculty status. Admin always follows ADMIN_EMAILS; faculty follows FACULTY_EMAILS
    OR the stored column (set at register/login now, by the nid API in the future)."""
    return {"is_admin": is_admin_email(user.email),
            "is_faculty": bool(getattr(user, "is_faculty", False)) or is_faculty_email(user.email)}


def hash_password(pw: str) -> str:
    return bcrypt.hashpw(pw.encode()[:72], bcrypt.gensalt()).decode()


def verify_password(pw: str, hashed: str) -> bool:
    try:
        return bcrypt.checkpw(pw.encode()[:72], hashed.encode())
    except ValueError:
        return False


def make_token(user: User) -> str:
    now = datetime.now(timezone.utc)
    payload = {"sub": str(user.id), "email": user.email, "iat": now,
               "exp": now + timedelta(hours=settings.jwt_ttl_hours)}
    return jwt.encode(payload, settings.jwt_secret, algorithm="HS256")


async def current_user(request: Request, token: str | None = Query(default=None),
                       session: AsyncSession = Depends(get_session)) -> User:
    """Bearer header, or ?token= (EventSource and <img src> cannot set headers)."""
    raw = token
    h = request.headers.get("authorization", "")
    if h.lower().startswith("bearer "):
        raw = h[7:]
    if not raw:
        raise HTTPException(401, "請先登入")
    try:
        data = jwt.decode(raw, settings.jwt_secret, algorithms=["HS256"])
        uid = uuid.UUID(data["sub"])
    except Exception:
        raise HTTPException(401, "登入已過期，請重新登入")
    user = await session.get(User, uid)
    if user is None:
        raise HTTPException(401, "帳號不存在")
    return user


async def require_admin(user: User = Depends(current_user)) -> User:
    if not is_admin_email(user.email):
        raise HTTPException(403, "只有管理員可以管理共用基礎庫")
    return user
