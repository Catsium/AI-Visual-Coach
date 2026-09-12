import base64
import json
import unittest
from os import environ
from unittest.mock import MagicMock, patch
from uuid import uuid4

from fastapi.testclient import TestClient

from main import app


def image_data_url(payload: bytes) -> str:
    return "data:image/png;base64," + base64.b64encode(payload).decode("ascii")


class FakeResponse:
    def __init__(self, content: dict) -> None:
        self.ok = True
        self._content = content

    def json(self) -> dict:
        return {
            "choices": [
                {"message": {"content": json.dumps(self._content)}}
            ]
        }


class FakeCursor:
    def __init__(self, database: "FakeDatabase") -> None:
        self.database = database
        self.result = None

    def __enter__(self) -> "FakeCursor":
        return self

    def __exit__(self, *_args) -> None:
        return None

    def execute(self, query: str, params: tuple) -> None:
        normalized = " ".join(query.split())
        self.database.queries.append((normalized, params))
        if "FROM coach_sessions" in normalized:
            self.result = {"session_id": params[0]} if self.database.session_exists else None
        elif "FROM coach_slides" in normalized:
            self.result = (
                {"diagnosis": self.database.diagnosis}
                if self.database.diagnosis is not None
                else None
            )
        else:
            raise AssertionError(f"Unexpected database query: {normalized}")

    def fetchone(self):
        return self.result


class FakeDatabase:
    def __init__(self, *, session_exists=True, diagnosis=None) -> None:
        self.session_exists = session_exists
        self.diagnosis = diagnosis
        self.queries: list[tuple[str, tuple]] = []

    def __enter__(self) -> "FakeDatabase":
        return self

    def __exit__(self, *_args) -> None:
        return None

    def cursor(self) -> FakeCursor:
        return FakeCursor(self)


class HologramEndpointTests(unittest.TestCase):
    def setUp(self) -> None:
        self.client = TestClient(app)
        self.session_id = str(uuid4())
        self.diagnosis = {
            "session_id": self.session_id,
            "slide_id": "slide-1",
            "coach_message": "Make the message easier to scan.",
            "problems": [
                {
                    "issue": "Weak hierarchy",
                    "evidence": "The title and body have similar visual weight.",
                    "fix": "Increase the title weight and reduce the body size.",
                    "target_area": "title and body",
                    "supported_action": "change_font_weight",
                }
            ],
            "additions": [],
        }
        self.generation_payload = {
            "session_id": self.session_id,
            "slide_id": "slide-1",
            "user_request": "Make this slide clearer",
            "slide_image": image_data_url(b"original-slide"),
        }

    def openai_success(self, encoded: str = "Z2VuZXJhdGVk") -> MagicMock:
        client = MagicMock()
        client.images.edit.return_value = MagicMock(
            data=[MagicMock(b64_json=encoded)]
        )
        return client

    def luna_acceptance(self, summary: str = "Clearer hierarchy") -> FakeResponse:
        return FakeResponse(
            {
                "can_apply": True,
                "image_prompt": "Edit only the diagnosed title hierarchy.",
                "summary": summary,
                "rejection_reason": "",
            }
        )

    def test_unknown_session_is_rejected_before_providers(self) -> None:
        database = FakeDatabase(session_exists=False, diagnosis=self.diagnosis)
        with (
            patch("main.get_db", return_value=database),
            patch("main.requests.post") as luna,
            patch("main.OpenAI") as openai,
        ):
            response = self.client.post("/hologram", json=self.generation_payload)

        self.assertEqual(response.status_code, 404)
        self.assertEqual(response.json()["detail"], "Unknown session_id")
        luna.assert_not_called()
        openai.assert_not_called()

    def test_missing_diagnosis_is_a_conflict(self) -> None:
        database = FakeDatabase(diagnosis=None)
        with patch("main.get_db", return_value=database):
            response = self.client.post("/hologram", json=self.generation_payload)

        self.assertEqual(response.status_code, 409)
        self.assertEqual(
            response.json()["detail"],
            "Diagnose this slide before generating an edited version.",
        )

    def test_null_supported_action_in_saved_diagnosis_is_a_conflict(self) -> None:
        self.diagnosis["problems"][0]["supported_action"] = None
        database = FakeDatabase(diagnosis=self.diagnosis)
        with (
            patch("main.get_db", return_value=database),
            patch("main.requests.post") as luna,
        ):
            response = self.client.post("/hologram", json=self.generation_payload)

        self.assertEqual(response.status_code, 409)
        luna.assert_not_called()

    def test_user_sourced_image_is_a_canonical_supported_action(self) -> None:
        self.diagnosis["problems"][0]["supported_action"] = "insert_user_sourced_image"
        database = FakeDatabase(diagnosis=self.diagnosis)
        openai_client = self.openai_success()
        with (
            patch("main.get_db", return_value=database),
            patch.dict(environ, {"OPENROUTER_API_KEY": "mock"}, clear=False),
            patch("main.requests.post", return_value=self.luna_acceptance()),
            patch("main.OpenAI", return_value=openai_client),
        ):
            response = self.client.post("/hologram", json=self.generation_payload)

        self.assertEqual(response.status_code, 200)

    def test_luna_receives_full_diagnosis_and_definitions_but_no_image(self) -> None:
        database = FakeDatabase(diagnosis=self.diagnosis)
        openai_client = self.openai_success()
        with (
            patch("main.get_db", return_value=database),
            patch.dict(environ, {"OPENROUTER_API_KEY": "mock"}, clear=False),
            patch("main.requests.post", return_value=self.luna_acceptance()) as luna,
            patch("main.OpenAI", return_value=openai_client),
        ):
            response = self.client.post("/hologram", json=self.generation_payload)

        self.assertEqual(response.status_code, 200)
        request_json = luna.call_args.kwargs["json"]
        serialized = json.dumps(request_json)
        prompt_text = request_json["messages"][0]["content"][0]["text"]
        self.assertIn(json.dumps(self.diagnosis, ensure_ascii=False), prompt_text)
        self.assertIn("change_font_weight", serialized)
        self.assertIn("insert_user_sourced_image", serialized)
        self.assertIn(self.generation_payload["user_request"], serialized)
        self.assertNotIn(self.generation_payload["slide_image"], serialized)
        self.assertNotIn("original-slide", serialized)
        self.assertEqual(
            request_json["messages"][0]["content"][0]["type"], "text"
        )
        self.assertEqual(len(request_json["messages"][0]["content"]), 1)

    def test_unsupported_revision_feedback_prevents_image_generation(self) -> None:
        database = FakeDatabase(diagnosis=self.diagnosis)
        rejection = FakeResponse(
            {
                "can_apply": False,
                "image_prompt": "",
                "summary": "",
                "rejection_reason": "That request is outside the supported changes.",
            }
        )
        payload = {
            **self.generation_payload,
            "current_hologram": image_data_url(b"current-hologram"),
            "feedback": "Replace the diagnosed content with an unrelated sales chart",
        }
        with (
            patch("main.get_db", return_value=database),
            patch.dict(environ, {"OPENROUTER_API_KEY": "mock"}, clear=False),
            patch("main.requests.post", return_value=rejection),
            patch("main.OpenAI") as openai,
        ):
            response = self.client.post("/revise-hologram", json=payload)

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["detail"],
            "That request is outside the supported changes.",
        )
        openai.assert_not_called()

    def test_revision_uses_configured_model_quality_and_image_order(self) -> None:
        database = FakeDatabase(diagnosis=self.diagnosis)
        openai_client = self.openai_success("cmV2aXNlZA==")
        payload = {
            **self.generation_payload,
            "current_hologram": image_data_url(b"current-hologram"),
            "feedback": "Use a calmer blue for the title",
        }
        with (
            patch("main.get_db", return_value=database),
            patch.dict(
                environ,
                {
                    "OPENROUTER_API_KEY": "mock",
                    "OPENAI_API_KEY": "mock-openai",
                    "OPENAI_IMAGE_MODEL": "configured-flare",
                    "OPENAI_IMAGE_QUALITY": "high",
                },
                clear=False,
            ),
            patch("main.requests.post", return_value=self.luna_acceptance()),
            patch("main.OpenAI", return_value=openai_client) as openai,
        ):
            response = self.client.post("/revise-hologram", json=payload)

        self.assertEqual(response.status_code, 200)
        openai.assert_called_once_with(api_key="mock-openai")
        kwargs = openai_client.images.edit.call_args.kwargs
        self.assertEqual(kwargs["model"], "configured-flare")
        self.assertEqual(kwargs["quality"], "high")
        self.assertEqual(kwargs["output_format"], "png")
        self.assertNotIn("size", kwargs)
        images = kwargs["image"]
        self.assertEqual(images[0].read(), b"current-hologram")
        self.assertEqual(images[1].read(), b"original-slide")

    def test_success_returns_png_data_url_and_luna_summary(self) -> None:
        database = FakeDatabase(diagnosis=self.diagnosis)
        openai_client = self.openai_success("cG5nLWJ5dGVz")
        with (
            patch("main.get_db", return_value=database),
            patch.dict(environ, {"OPENROUTER_API_KEY": "mock"}, clear=False),
            patch("main.requests.post", return_value=self.luna_acceptance("Improved title")),
            patch("main.OpenAI", return_value=openai_client),
        ):
            response = self.client.post("/hologram", json=self.generation_payload)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(
            response.json(),
            {
                "session_id": self.session_id,
                "slide_id": "slide-1",
                "hologram_image": "data:image/png;base64,cG5nLWJ5dGVz",
                "summary": "Improved title",
            },
        )

    def test_revision_requires_a_current_hologram(self) -> None:
        database = FakeDatabase(diagnosis=self.diagnosis)
        payload = {
            **self.generation_payload,
            "current_hologram": "",
            "feedback": "Use blue",
        }
        with patch("main.get_db", return_value=database):
            response = self.client.post("/revise-hologram", json=payload)

        self.assertEqual(response.status_code, 400)
        self.assertEqual(
            response.json()["detail"],
            "No generated image is available to revise.",
        )

    def test_malformed_data_urls_are_rejected(self) -> None:
        database = FakeDatabase(diagnosis=self.diagnosis)
        malformed_payloads = [
            {**self.generation_payload, "slide_image": "not-a-data-url"},
            {
                **self.generation_payload,
                "current_hologram": "data:image/png;base64,%%%",
                "feedback": "Use blue",
            },
        ]
        paths = ["/hologram", "/revise-hologram"]
        for path, payload in zip(paths, malformed_payloads):
            with self.subTest(path=path), patch("main.get_db", return_value=database):
                response = self.client.post(path, json=payload)
            self.assertEqual(response.status_code, 400)

    def test_malformed_luna_response_is_a_bad_gateway(self) -> None:
        database = FakeDatabase(diagnosis=self.diagnosis)
        with (
            patch("main.get_db", return_value=database),
            patch.dict(environ, {"OPENROUTER_API_KEY": "mock"}, clear=False),
            patch("main.requests.post", return_value=FakeResponse({"can_apply": True})),
            patch("main.OpenAI") as openai,
        ):
            response = self.client.post("/hologram", json=self.generation_payload)

        self.assertEqual(response.status_code, 502)
        openai.assert_not_called()

    def test_openai_failure_is_a_concise_bad_gateway(self) -> None:
        database = FakeDatabase(diagnosis=self.diagnosis)
        openai_client = MagicMock()
        openai_client.images.edit.side_effect = RuntimeError("secret provider details")
        with (
            patch("main.get_db", return_value=database),
            patch.dict(environ, {"OPENROUTER_API_KEY": "mock"}, clear=False),
            patch("main.requests.post", return_value=self.luna_acceptance()),
            patch("main.OpenAI", return_value=openai_client),
        ):
            response = self.client.post("/hologram", json=self.generation_payload)

        self.assertEqual(response.status_code, 502)
        self.assertEqual(response.json()["detail"], "Image generation failed.")
        self.assertNotIn("secret provider details", response.text)

    def test_endpoints_never_persist_image_data(self) -> None:
        database = FakeDatabase(diagnosis=self.diagnosis)
        openai_client = self.openai_success()
        with (
            patch("main.get_db", return_value=database),
            patch.dict(environ, {"OPENROUTER_API_KEY": "mock"}, clear=False),
            patch("main.requests.post", return_value=self.luna_acceptance()),
            patch("main.OpenAI", return_value=openai_client),
        ):
            response = self.client.post("/hologram", json=self.generation_payload)

        self.assertEqual(response.status_code, 200)
        self.assertEqual(len(database.queries), 2)
        self.assertTrue(all(query.startswith("SELECT") for query, _ in database.queries))
        serialized_queries = json.dumps(database.queries, default=str)
        self.assertNotIn("original-slide", serialized_queries)
        self.assertNotIn("Z2VuZXJhdGVk", serialized_queries)


if __name__ == "__main__":
    unittest.main()
