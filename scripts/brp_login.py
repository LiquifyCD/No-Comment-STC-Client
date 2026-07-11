from __future__ import annotations

import getpass
import os
import sys
from typing import Any

import requests


BASE_URL = "https://stc.brpsystems.com/brponline/api/ver3"
APP_ID = 383

COMMON_HEADERS = {
    "Accept": "application/json",
    "Content-Type": "application/json",
    "X-Request-Source": "mobilityapp",
    "Accept-Language": "sv-SE",
    "User-Agent": "GoActive/2 PythonClient/1.0",
}


def request_json(
    session: requests.Session,
    method: str,
    url: str,
    **kwargs: Any,
) -> dict[str, Any]:
    response = session.request(method, url, timeout=20, **kwargs)

    try:
        response.raise_for_status()
    except requests.HTTPError as exc:
        print(f"Request failed: HTTP {response.status_code}", file=sys.stderr)

        # Avoid accidentally printing tokens or credentials.
        content_type = response.headers.get("content-type", "")
        if "application/json" in content_type:
            try:
                error_data = response.json()
                print(f"Server response: {error_data}", file=sys.stderr)
            except ValueError:
                pass

        raise RuntimeError("BRP API request failed") from exc

    try:
        data = response.json()
    except ValueError as exc:
        raise RuntimeError("Server did not return valid JSON") from exc

    if not isinstance(data, dict):
        raise RuntimeError("Unexpected response format")

    return data


def main() -> None:
    username = os.getenv("BRP_USERNAME") or input("BRP username: ").strip()
    password = os.getenv("BRP_PASSWORD") or getpass.getpass("BRP password: ")

    if not username or not password:
        raise RuntimeError("Username and password are required")

    with requests.Session() as session:
        session.headers.update(COMMON_HEADERS)

        # Load the app configuration first. This may also cause the server or
        # Google load balancer to establish a GCLB session cookie.
        app_config_url = (
            f"{BASE_URL}/apps/{APP_ID}"
            "?allowMultipleCompaniesAndBusinessUnits=true"
        )

        config_response = session.get(app_config_url, timeout=20)
        config_response.raise_for_status()

        print("App configuration loaded.")
        print("Session cookies:", list(session.cookies.keys()))

        # Authenticate using the same endpoint observed in the official app.
        login_data = request_json(
            session,
            "POST",
            f"{BASE_URL}/auth/login",
            json={
                "username": username,
                "password": password,
            },
        )

        access_token = login_data.get("access_token")
        refresh_token = login_data.get("refresh_token")
        customer_id = str(login_data.get("username", username))
        expires_in = login_data.get("expires_in")

        if not isinstance(access_token, str) or not access_token:
            raise RuntimeError("Login succeeded but no access token was returned")

        session.headers["Authorization"] = f"Bearer {access_token}"

        print("Login successful.")
        print(f"Customer ID: {customer_id}")
        print(f"Token expires in: {expires_in} seconds")
        print(f"Refresh token received: {bool(refresh_token)}")
        print("Bearer token is stored only in memory and will not be printed.")

        # Safely read the authenticated user's own profile.
        customer = request_json(
            session,
            "GET",
            f"{BASE_URL}/customers/{customer_id}",
        )

        print("\nCustomer profile returned successfully.")
        print("Available fields:")
        for key in sorted(customer.keys()):
            print(f"  - {key}")


if __name__ == "__main__":
    try:
        main()
    except KeyboardInterrupt:
        print("\nCancelled.")
    except Exception as exc:
        print(f"\nError: {exc}", file=sys.stderr)
        sys.exit(1)
