import io
import unittest
from app import app, clean_headers

class CleaningTests(unittest.TestCase):
    def setUp(self):
        self.client = app.test_client()

    def clean(self, text, **options):
        return self.client.post('/api/clean-csv', data={
            'file': (io.BytesIO(text.encode('utf-8')), 'data.csv'), **options,
        }, content_type='multipart/form-data')

    def test_preserves_ids_missing_values_and_literal_na(self):
        r = self.clean('ID,Name,Country\n00123,,NA\n00456,Bob,KE\n')
        self.assertEqual(r.status_code, 200)
        self.assertIn('00123,,NA', r.text)
        self.assertNotIn('nan', r.text)

    def test_header_collisions(self):
        self.assertEqual(clean_headers(['A', 'A', 'A_1', '']), ['a', 'a_1', 'a_1_1', 'col'])
        r = self.clean('A,A,A_1,\n1,2,3,4\n')
        self.assertTrue(r.text.startswith('a,a_1,a_1_1,col\n'))

    def test_trim_empty_columns_and_dedupe(self):
        r = self.clean('Name,Empty,ID\n Alice , ,001\nAlice,,001\n')
        self.assertEqual(r.headers['X-Empty-Cols-Removed'], '1')
        self.assertEqual(r.headers['X-Duplicates-Removed'], '1')
        self.assertEqual(r.text, 'name,id\nAlice,001\n')

    def test_dates_preserve_invalid_and_ambiguous_values(self):
        r = self.clean('Date\n2026/10/18\nunknown\n01/02/2026\n', normalize_dates='true')
        self.assertIn('2026-10-18', r.text)
        self.assertIn('unknown', r.text)
        self.assertIn('01/02/2026', r.text)

    def test_quoted_and_blank_headers(self):
        r = self.clean('"Last, first",,ID\n"Oluoch, Ben",value,001\n')
        self.assertTrue(r.text.startswith('last_first,col,id\n'))

    def test_selected_empty_column_does_not_break_cleaning(self):
        r = self.clean('ID,Blank\n001, \n001,\n', dedupe_cols='id,blank')
        self.assertEqual(r.status_code, 200)
        self.assertEqual(r.headers['X-Output-Rows'], '1')

    def test_empty_file_returns_readable_error(self):
        r = self.clean('')
        self.assertEqual(r.status_code, 400)
        self.assertIn('error', r.json)

    def test_upload_limit_returns_json(self):
        old = app.config['MAX_CONTENT_LENGTH']
        try:
            app.config['MAX_CONTENT_LENGTH'] = 10
            r = self.clean('ID\n001\n')
            self.assertEqual(r.status_code, 413)
            self.assertIn('20 MB', r.json['error'])
        finally:
            app.config['MAX_CONTENT_LENGTH'] = old

if __name__ == '__main__':
    unittest.main()
