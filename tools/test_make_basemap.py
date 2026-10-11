"""Tests de l'outil : jeu de données SYNTHÉTIQUE (aucune donnée réelle)."""
import json, pytest, make_basemap as m
from pmtiles.reader import Reader, MmapSource
GJ = {"type": "FeatureCollection", "features": [{"type": "Feature", "properties": {"building": "yes"}, "geometry": {"type": "Polygon", "coordinates": [[[0.001, 0.001], [0.0016, 0.001], [0.0016, 0.0016], [0.001, 0.0016], [0.001, 0.001]]]}}]}
def run(tmp_path, *extra, data=GJ):
    g = tmp_path / "d.geojson"; g.write_text(json.dumps(data)); out = tmp_path / "o.pmtiles"; m.main(["--geojson", str(g), "--out", str(out), *extra]); return out
def test_osm_adds_mandatory_attribution(tmp_path):
    out = run(tmp_path, "--source", "osm", "--maxzoom", "16")
    with open(out, "rb") as f: r = Reader(MmapSource(f)); assert "OpenStreetMap" in r.metadata()["attribution"] and r.header()["tile_type"].name == "PNG"
def test_refuses_empty_data(tmp_path):
    with pytest.raises(SystemExit): run(tmp_path, data={"type": "FeatureCollection", "features": []})
def test_refuses_oversized_request(tmp_path):
    with pytest.raises(SystemExit): run(tmp_path, "--max-tiles", "5", "--maxzoom", "19")
def test_tile_math_known_value():
    x, y = m.lonlat_to_px(0, 0, 0); assert (x, y) == (128, 128)   # centre du monde au zoom 0
