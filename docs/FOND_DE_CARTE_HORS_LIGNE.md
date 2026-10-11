# Produire le fond de carte hors ligne (licences)

Le fichier attendu est `tiles/kossodo.pmtiles` (PMTiles raster PNG). **Je n'ai pas pu produire ce fichier à votre place** : aucune source de données cartographiques n'est accessible depuis mon environnement, et aucun relevé réel de Kossodo n'existe encore. L'outil `tools/make_basemap.py` le fabrique chez vous, à partir de données dont vous détenez les droits. Il ne télécharge **jamais** de tuiles d'un serveur de cartes.

## Ce qu'il ne faut PAS faire
- Aspirer les tuiles de `tile.openstreetmap.org` : la politique d'usage de ce service interdit le téléchargement massif et l'usage hors ligne de ses tuiles.
- Copier des fonds Google Maps, Bing, Esri, Mapbox, Apple, ou des captures d'écran : leurs conditions interdisent la copie et la mise en cache hors ligne.

## Option A — vos propres relevés (la plus sûre, à faire en premier)
Après la publication de vos relevés (bâtiments, terrains, allées, clôtures…) :
```
pip install pillow pmtiles
python tools/make_basemap.py --api https://<votre-domaine> --out tiles/kossodo.pmtiles
```
Licence : vos données (CENOU), mention « Données MaCité / CENOU » inscrite dans le fichier. Rendu abstrait (formes et chemins, sans nom de rues) mais suffisant pour se repérer et naviguer. L'outil refuse de générer un fond vide.

## Option B — données OpenStreetMap (ODbL), rendues par vous
Les **données** OpenStreetMap peuvent servir à dessiner vos propres tuiles, à condition de citer « © contributeurs OpenStreetMap » (lien vers la licence ODbL) ; si vous modifiez ou redistribuez l'extrait de données lui-même, il reste sous ODbL. Vérifiez les conditions à jour sur <https://www.openstreetmap.org/copyright> (je n'ai pas pu les consulter en ligne depuis mon environnement) et, pour un usage institutionnel, faites-les valider par la personne compétente à la CENOU.
1. Exportez les données de la zone de la cité (petite emprise) au format GeoJSON : par exemple via l'export de la zone sur openstreetmap.org, un outil comme Overpass Turbo (« Export → GeoJSON ») ou un extrait régional. Respectez la politique d'usage de ces services : petites requêtes, pas d'automatisation lourde.
2. `python tools/make_basemap.py --geojson extrait.geojson --source osm --out tiles/kossodo.pmtiles`
3. L'attribution est inscrite dans le fichier **et affichée sur la carte** par l'application. Ne la retirez pas.
Peut se combiner avec l'option A : `--api … --geojson … --source osm`.
Qualité : dépend de la couverture OSM de Kossodo (souvent partielle) ; complétez-la dans OSM si vous le souhaitez, ou avec vos relevés.

## Option C — imagerie aérienne / drone
Possible seulement si la CENOU détient les droits (survol par drone, imagerie commandée) ou si la licence de l'image l'autorise explicitement (vérifiez image par image, mention d'auteur comprise). Conversion en PMTiles avec des outils tiers (`gdal2tiles`, `pmtiles convert`) : non fournis ici.

## Contrôles
- `--max-tiles` (20 000 par défaut) évite de produire un fichier démesuré ; ajustez `--minzoom` / `--maxzoom` (15–19 par défaut) et `--margin-m`.
- Copiez le fichier sur le serveur (`tiles/`), puis sur chaque téléphone : onglet Synchro → « Télécharger la carte ». Sans réseau, les zooms absents du fichier ne s'affichent pas.
- Mesurez la taille réelle de votre fichier avant de demander aux contributeurs de le télécharger en 3G/4G.
