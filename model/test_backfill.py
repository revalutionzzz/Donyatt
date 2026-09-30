import unittest

from backfill import normalise_row, to_stage


class ToStageTest(unittest.TestCase):
    def test_converts_mAOD_to_stage(self):
        # 31 Dec 2000 record: 37.632 mAOD in the archive, 2.632 m on the EA stage scale.
        self.assertEqual(to_stage(37.632, 35.0), (2.632, True))

    def test_leaves_stage_readings_alone(self):
        self.assertEqual(to_stage(0.226, 35.0), (0.226, False))
        self.assertEqual(to_stage(0.0, 35.0), (0.0, False))

    def test_row_normalisation(self):
        row = {"dateTime": "2000-12-31T22:45:00", "value": "37.632", "quality": "Good", "completeness": "", "qcode": ""}
        out = normalise_row(row, 35.0)
        self.assertEqual(out["ts_utc"], "2000-12-31T22:45:00Z")
        self.assertEqual((out["value"], out["raw_value"], out["datum_converted"]), (2.632, 37.632, 1))

    def test_rain_is_not_converted_and_blank_values_are_dropped(self):
        self.assertEqual(normalise_row({"dateTime": "2024-01-01T00:00:00", "value": "0.2"}, None)["value"], 0.2)
        self.assertIsNone(normalise_row({"dateTime": "2024-01-01T00:00:00", "value": ""}, None))


if __name__ == "__main__":
    unittest.main()
