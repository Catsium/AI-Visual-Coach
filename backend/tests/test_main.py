import unittest
from os import environ
from unittest.mock import patch
from uuid import UUID, uuid4

from fastapi.testclient import TestClient

from main import app, get_allowed_origins


class BackendApiTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)

    def create_session(self) -> str:
        response = self.client.post("/session")
        self.assertEqual(response.status_code, 201)
        session_id = response.json()["session_id"]
        self.assertEqual(UUID(session_id).version, 4)
        return session_id

    def test_health_endpoint_is_preserved(self) -> None:
        response = self.client.get("/health")

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.json(), {"status": "ok"})

    def test_session_endpoint_returns_a_uuid(self) -> None:
        self.create_session()

    def test_diagnose_returns_only_a_requested_supported_action(self) -> None:
        session_id = self.create_session()
        supported_actions = ["change_font_size", "adjust_alignment"]

        response = self.client.post(
            "/diagnose",
            json={
                "session_id": session_id,
                "user_request": "Make this slide clearer",
                "slide_image": "data:image/png;base64,mock",
                "supported_actions": supported_actions,
            },
        )

        self.assertEqual(response.status_code, 200)
        diagnosis = response.json()
        self.assertEqual(diagnosis["session_id"], session_id)
        self.assertEqual(diagnosis["additions"], [])
        self.assertEqual(diagnosis["problems"][0]["supported_action"], supported_actions[0])
        self.assertTrue(
            all(
                change["supported_action"] in supported_actions
                for change in diagnosis["problems"] + diagnosis["additions"]
                if change["supported_action"] is not None
            )
        )

    def test_diagnose_with_no_supported_actions_assigns_none(self) -> None:
        session_id = self.create_session()

        response = self.client.post(
            "/diagnose",
            json={
                "session_id": session_id,
                "user_request": "Make this slide clearer",
                "slide_image": "placeholder-image",
                "supported_actions": [],
            },
        )

        self.assertEqual(response.status_code, 200)
        changes = response.json()["problems"] + response.json()["additions"]
        self.assertTrue(all(change["supported_action"] is None for change in changes))

    def test_diagnose_rejects_an_unknown_session(self) -> None:
        response = self.client.post(
            "/diagnose",
            json={
                "session_id": str(uuid4()),
                "user_request": "Make this slide clearer",
                "slide_image": "placeholder-image",
                "supported_actions": [],
            },
        )

        self.assertEqual(response.status_code, 404)

    def test_diagnose_rejects_malformed_requests(self) -> None:
        response = self.client.post(
            "/diagnose",
            json={
                "session_id": "not-a-uuid",
                "user_request": "",
                "supported_actions": [],
            },
        )

        self.assertEqual(response.status_code, 422)

    def test_cors_allows_chrome_extension_preflight_in_development(self) -> None:
        response = self.client.options(
            "/diagnose",
            headers={
                "Origin": "chrome-extension://development-extension-id",
                "Access-Control-Request-Method": "POST",
            },
        )

        self.assertEqual(response.status_code, 200)
        self.assertEqual(response.headers["access-control-allow-origin"], "*")

    def test_cors_parses_configured_origins_and_empty_values(self) -> None:
        with patch.dict(
            environ,
            {
                "CORS_ALLOWED_ORIGINS": (
                    "chrome-extension://extension-id, https://frontend.example "
                )
            },
            clear=False,
        ):
            self.assertEqual(
                get_allowed_origins(),
                ["chrome-extension://extension-id", "https://frontend.example"],
            )

        with patch.dict(environ, {"CORS_ALLOWED_ORIGINS": ""}, clear=False):
            self.assertEqual(get_allowed_origins(), [])


if __name__ == "__main__":
    unittest.main()
