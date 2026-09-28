# Покрытие OSM: Томск

Отчёт сгенерирован скриптом `python -m geopuls.recon.pbf_scan` (Этап 0.5, см. `docs/tz.md`). Не редактируйте вручную — изменения потеряются при повторном запуске.

| Параметр | Значение |
|---|---|
| Файл выгрузки | `siberian-fed-district-260927.osm.pbf` (557.4 МБ) |
| Дата файла | 2026-09-28T10:57:34+00:00 |
| Дата данных OSM | 2026-09-27T20:23:36Z |
| BBox (min_lat, min_lon, max_lat, max_lon) | 56.3, 84.7, 56.65, 85.3 |
| Центр и радиус «ядра» | 56.4847, 84.9482 — 10.0 км |
| Время сканирования | 1687.6 с |
| Объектов с POI-тегами в bbox | 14275 |
| Из них в категориях MVP | 2151 (не попали в категории: 84.9%) |
| Объектов сразу в нескольких категориях | 0 |
| POI-отношений (relations) по всему региону | 1905 |

## Категории MVP

| Категория | Всего | nodes | ways | С названием | С адресом | С брендом | В ядре | Оценка |
|---|---|---|---|---|---|---|---|---|
| `cafe` | 271 | 251 | 20 | 95% | 48% | 13 | 249 | ok |
| `restaurant` | 87 | 78 | 9 | 99% | 61% | 0 | 82 | ok |
| `bar` | 64 | 58 | 6 | 97% | 39% | 0 | 60 | ok |
| `pharmacy` | 257 | 249 | 8 | 94% | 55% | 15 | 238 | ok |
| `beauty` | 342 | 339 | 3 | 96% | 46% | 0 | 332 | ok |
| `fitness` | 33 | 32 | 1 | 97% | 48% | 0 | 32 | ok |
| `grocery` | 596 | 476 | 120 | 89% | 57% | 248 | 492 | ok |
| `pickup_point` | 501 | 500 | 1 | 99% | 32% | 307 | 429 | ok |

Порог «мало данных» — менее 30 объектов на категорию в bbox.

## Частоты значений по ключам POI (кандидаты на новые категории, проверка маппинга)

### `amenity`

| Значение | Объектов |
|---|---|
| `parking` | 2370 |
| `bench` | 1015 |
| `waste_disposal` | 431 |
| `atm` | 350 |
| `cafe` | 271 |
| `pharmacy` | 257 |
| `drinking_water` | 227 |
| `kindergarten` | 221 |
| `fast_food` | 171 |
| `school` | 164 |
| `waste_basket` | 125 |
| `hospital` | 120 |
| `bank` | 119 |
| `fuel` | 109 |
| `dentist` | 109 |
| `post_office` | 93 |
| `bicycle_parking` | 93 |
| `recycling` | 88 |
| `restaurant` | 87 |
| `public_building` | 87 |
| `vending_machine` | 74 |
| `toilets` | 68 |
| `car_wash` | 62 |
| `clinic` | 60 |
| `police` | 57 |

### `shop`

| Значение | Объектов |
|---|---|
| `outpost` | 482 |
| `supermarket` | 331 |
| `convenience` | 265 |
| `hairdresser` | 250 |
| `car_repair` | 233 |
| `clothes` | 195 |
| `alcohol` | 141 |
| `car_parts` | 126 |
| `greengrocer` | 121 |
| `doityourself` | 115 |
| `florist` | 98 |
| `beauty` | 92 |
| `furniture` | 67 |
| `bakery` | 61 |
| `butcher` | 57 |
| `confectionery` | 51 |
| `jewelry` | 50 |
| `mobile_phone` | 50 |
| `mall` | 50 |
| `beverages` | 47 |
| `electronics` | 43 |
| `hardware` | 37 |
| `pet` | 36 |
| `shoes` | 34 |
| `cosmetics` | 34 |

### `leisure`

| Значение | Объектов |
|---|---|
| `playground` | 780 |
| `pitch` | 350 |
| `park` | 217 |
| `sports_centre` | 77 |
| `fitness_station` | 63 |
| `track` | 54 |
| `sauna` | 36 |
| `fitness_centre` | 33 |
| `common` | 26 |
| `resort` | 16 |
| `firepit` | 16 |
| `garden` | 14 |
| `sports_hall` | 13 |
| `swimming_pool` | 12 |
| `stadium` | 12 |
| `amusement_arcade` | 10 |
| `ice_rink` | 8 |
| `dance` | 6 |
| `fishing` | 6 |
| `indoor_play` | 5 |
| `bandstand` | 4 |
| `outdoor_seating` | 4 |
| `picnic_table` | 4 |
| `recreation_ground` | 4 |
| `dog_park` | 4 |

### `office`

| Значение | Объектов |
|---|---|
| `company` | 155 |
| `government` | 66 |
| `telecommunication` | 27 |
| `lawyer` | 25 |
| `yes` | 20 |
| `insurance` | 20 |
| `logistics` | 16 |
| `notary` | 14 |
| `accountant` | 13 |
| `construction_company` | 13 |
| `estate_agent` | 11 |
| `travel_agent` | 10 |
| `research` | 9 |
| `advertising_agency` | 9 |
| `security` | 9 |
| `financial_advisor` | 4 |
| `it` | 3 |
| `surveyor` | 3 |
| `newspaper` | 3 |
| `educational_institution` | 2 |
| `architect` | 2 |
| `ngo` | 2 |
| `financial` | 1 |
| `moving_company` | 1 |
| `coworking` | 1 |

### `craft`

| Значение | Объектов |
|---|---|
| `electronics_repair` | 27 |
| `window_construction` | 14 |
| `photographer` | 8 |
| `hvac` | 8 |
| `metal_construction` | 4 |
| `jeweller` | 3 |
| `shoemaker` | 3 |
| `caterer` | 3 |
| `ceiling` | 3 |
| `tailor` | 3 |
| `locksmith` | 3 |
| `key_cutter` | 2 |
| `sawmill` | 2 |
| `floorer` | 2 |
| `plumber` | 2 |
| `upholsterer` | 2 |
| `clothes` | 1 |
| `lacquerer` | 1 |
| `carpenter` | 1 |
| `roofer` | 1 |
| `cleaning` | 1 |
| `stonemason` | 1 |
| `brewery` | 1 |
| `beekeeper` | 1 |

### `tourism`

| Значение | Объектов |
|---|---|
| `hotel` | 87 |
| `artwork` | 84 |
| `picnic_site` | 66 |
| `information` | 42 |
| `attraction` | 31 |
| `viewpoint` | 31 |
| `museum` | 21 |
| `guest_house` | 13 |
| `hostel` | 11 |
| `motel` | 9 |
| `camp_site` | 9 |
| `theme_park` | 4 |
| `caravan_site` | 3 |
| `zoo` | 3 |
| `trail_riding_station` | 1 |
| `apartment` | 1 |
| `gallery` | 1 |

### `healthcare`

| Значение | Объектов |
|---|---|
| `pharmacy` | 214 |
| `hospital` | 91 |
| `dentist` | 86 |
| `clinic` | 51 |
| `laboratory` | 29 |
| `doctor` | 27 |
| `yes` | 9 |
| `rehabilitation` | 3 |
| `alternative` | 1 |
| `psychotherapist` | 1 |

### `club`

| Значение | Объектов |
|---|---|
| `sport` | 28 |
| `yes` | 1 |
| `computer` | 1 |
| `dog` | 1 |

### `sport`

| Значение | Объектов |
|---|---|
| `soccer` | 61 |
| `basketball` | 46 |
| `fitness` | 26 |
| `running` | 20 |
| `volleyball` | 16 |
| `ice_hockey` | 14 |
| `swimming` | 13 |
| `roller_skiing` | 10 |
| `multi` | 9 |
| `tennis` | 8 |
| `skateboard` | 5 |
| `horse_racing` | 5 |
| `hockey` | 5 |
| `shooting` | 4 |
| `futsal` | 4 |
| `skiing` | 3 |
| `climbing` | 3 |
| `dance` | 3 |
| `athletics` | 3 |
| `beachvolleyball` | 3 |
| `football` | 3 |
| `ice_skating` | 3 |
| `trampoline` | 2 |
| `karate` | 2 |
| `yoga` | 2 |

## Ограничения отчёта

- Учитываются только объекты с тегами POI; объекты без таких тегов в знаменатель не попадают.
- Полигональные POI-отношения (relations) в подсчёт по bbox не включены — только их общее число по региону.
- Центроиды ways вычислены как среднее координат узлов: для оценки покрытия этого достаточно, в импортёре (Этап 2) будет использоваться `ST_PointOnSurface`.
- Разведка отвечает на вопрос «сколько размечено в OSM», а не «сколько организаций есть в городе».
