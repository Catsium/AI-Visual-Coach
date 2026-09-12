import base64
import json
import tempfile
import unittest
from os import environ
from pathlib import Path
from unittest.mock import Mock, patch

from fastapi import HTTPException

import teaching


class TeachingTests(unittest.TestCase):
    def test_sample_ids_map_to_the_required_filenames(self) -> None:
        self.assertEqual(
            teaching.SAMPLE_IMAGE_PAIRS["sample_a"],
            ("slide_a_original.png", "slide_a_approved.png"),
        )
        self.assertEqual(
            teaching.SAMPLE_IMAGE_PAIRS["sample_b"],
            ("slide_b_original.png", "slide_b_approved.png"),
        )

    def test_missing_sample_image_returns_a_useful_404(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            with patch.object(teaching, "TEACHING_SAMPLES_DIR", Path(temporary_directory)):
                with self.assertRaises(HTTPException) as raised:
                    teaching.get_sample_image_paths("sample_a")

        self.assertEqual(raised.exception.status_code, 404)
        self.assertIn("slide_a_original.png", str(raised.exception.detail))

    def test_teaching_request_sends_both_labeled_images_together(self) -> None:
        model_response = {
            "overview": "Make the approved title treatment and image emphasis.",
            "steps": [
                {
                    "step": 1,
                    "title": "Select the title",
                    "instruction": "Click the top-left title text box.",
                    "explanation": "This prepares the title for the approved format.",
                    "target_area": "top-left title",
                    "action": "select_object",
                    "value": None,
                }
            ],
        }
        openrouter_response = Mock(ok=True)
        openrouter_response.json.return_value = {
            "choices": [{"message": {"content": json.dumps(model_response)}}]
        }

        with tempfile.TemporaryDirectory() as temporary_directory:
            original_image = Path(temporary_directory) / "original.png"
            approved_image = Path(temporary_directory) / "approved.png"
            original_image.write_bytes(b"original-image")
            approved_image.write_bytes(b"approved-image")

            with patch.dict(environ, {"OPENROUTER_API_KEY": "test-key"}, clear=False):
                with patch("teaching.requests.post", return_value=openrouter_response) as post:
                    response = teaching.generate_teaching_plan(
                        original_image,
                        approved_image,
                        model="openai/gpt-luna-latest",
                    )

        self.assertEqual(response.model_dump(), model_response)
        post.assert_called_once()
        payload = post.call_args.kwargs["json"]
        content = payload["messages"][0]["content"]

        self.assertEqual(payload["model"], "openai/gpt-luna-latest")
        self.assertEqual(content[1]["text"], "IMAGE 1 = ORIGINAL SLIDE")
        self.assertEqual(
            content[3]["text"],
            "IMAGE 2 = APPROVED EDITED SLIDE (authoritative target)",
        )
        self.assertEqual(
            content[2]["image_url"]["url"],
            f"data:image/png;base64,{base64.b64encode(b'original-image').decode('ascii')}",
        )
        self.assertEqual(
            content[4]["image_url"]["url"],
            f"data:image/png;base64,{base64.b64encode(b'approved-image').decode('ascii')}",
        )


if __name__ == "__main__":
    unittest.main()
