# Talion Crisis Comm - TODO

## Phase 1: Authentication & Role-Based Access
- [x] Créer le système d'authentification (login/signup)
- [x] Implémenter les rôles utilisateur (responder, dispatcher, admin, user)
- [x] Configurer la base de données utilisateurs
- [x] Créer hook useAuth() pour vérifier rôle utilisateur
- [x] Implémenter persistance de session (AsyncStorage)
- [x] Ajouter logout et gestion de session
- [x] Créer middleware pour protéger les routes par rôle
- [x] Mettre à jour branding : Talion Crisis Comm avec logo

## Phase 2: Mobile Responder Interface
- [x] Créer l'écran d'accueil avec statut utilisateur
- [x] Ajouter bouton SOS avec partage de localisation
- [x] Implémenter alerte SOS pour le dispatch
- [x] Ajouter quittance d'alerte pour dispatcher
- [x] Bouton SOS visible pour tous les rôles (users, responders, dispatchers)
- [x] Implémenter la carte avec géolocalisation (Phase 9+10: carte interactive + GPS réel)
- [x] Afficher les incidents à proximité sur l'écran d'accueil (avec distance GPS Haversine)
- [x] Améliorer contrôles de statut (persistance + sync WebSocket + notification dispatch)
- [x] Créer l'interface de messagerie (Phase 6: écran Messages avec TalionBanner)
- [x] Implémenter le PTT (Phase 7: PTT complet avec canaux et WebSocket)

## Phase 3: Mobile Dispatcher Interface (Role-Gated Tab)
- [x] Ajouter onglet Dispatcher (visible seulement si rôle=dispatcher)
- [x] Créer tableau de bord dispatcher avec alertes SOS actives
- [x] Implémenter liste des responders avec statuts
- [x] Ajouter carte en temps réel avec localisation des responders (Phase 9: carte interactive)
- [x] Améliorer système de gestion d'incidents (assign responder, timeline, close incident)
- [x] Ajouter diffusion d'alerte ciblée par zone (Zone Broadcast modal avec rayon)
- [x] Améliorer messagerie dispatcher-responder (messages directs)

## Phase 4: Real-Time Features & Alert Creation
- [x] Implémenter WebSocket pour alertes en temps réel
- [x] Créer service WebSocket pour streaming d'alertes
- [x] Implémenter suivi de localisation en temps réel
- [x] Ajouter gestion de reconnexion WebSocket
- [x] Créer interface de création d'alerte pour dispatchers et responders
- [x] Ajouter capture de localisation pour alertes (dispatchers/responders seulement)
- [x] Implémenter sélection du type d'alerte (SOS, Médical, Incendie, etc.)
- [ ] Ajouter upload de photos/pièces jointes
- [x] Implémenter notifications push (Phase 8: service complet avec canaux)
- [x] Ajouter les sons d'alerte (SOS, notification, PTT)
- [x] Créer l'historique des conversations et messagerie directe dispatcher-responder

## Phase 5: Admin Console (In-App)
- [x] Créer onglet Admin (visible seulement si rôle=admin)
- [x] Implémenter gestion des utilisateurs (liste, recherche, changement de rôle, suspension, désactivation)
- [x] Ajouter gestion des incidents (liste filtrée, statistiques, détails complets)
- [x] Créer tableau de bord d'analytics (métriques clés, graphiques par rôle/sévérité, santé système)
- [x] Ajouter logs d'audit (filtrage par catégorie, historique persistant, création automatique)
- [x] Tester la console admin (45 tests passés)

## Phase 6: Testing & Deployment
- [ ] Tester tous les flux utilisateur
- [ ] Optimiser les performances
- [ ] Préparer pour le déploiement
- [ ] Créer la documentation

## Phase 5: Backend WebSocket Server
- [x] Créer serveur WebSocket avec ws ou Socket.io
- [x] Implémenter gestion des connexions utilisateur
- [x] Implémenter streaming d'alertes en temps réel
- [x] Implémenter suivi de localisation des responders
- [ ] Ajouter persistance des alertes en base de données
- [x] Implémenter gestion des erreurs et reconnexion
- [ ] Tester la communication bidirectionnelle

## Phase 6: UI Improvements
- [x] Ajouter banner Talion en haut de l'écran (sous la safe area)
- [x] Déplacer le nom de l'app plus bas pour éviter la caméra
- [x] Créer composant Banner réutilisable (TalionScreen / TalionBanner)
- [x] Appliquer banner à l'écran Messages
- [x] Appliquer banner à l'écran Map
- [x] Appliquer banner à l'écran Dispatcher
- [x] Appliquer banner à l'écran Login

## Phase 7: Push-to-Talk (PTT)
- [x] Lire documentation expo-audio pour enregistrement et lecture
- [x] Créer service PTT (enregistrement, lecture, gestion des canaux)
- [x] Créer écran PTT avec sélection de canal et bouton Talk
- [x] Implémenter enregistrement audio avec bouton maintenu
- [x] Implémenter lecture audio des messages reçus
- [x] Intégrer PTT avec WebSocket pour transmission en temps réel
- [x] Ajouter indicateurs visuels (qui parle, canal actif, historique)
- [x] Ajouter retour haptique pour le bouton PTT
- [x] Tester la fonctionnalité PTT complète (21 tests passés)

## Phase 8: Push Notifications
- [x] Lire documentation expo-notifications
- [x] Créer service de notifications (permissions, tokens, scheduling)
- [x] Implémenter notifications locales pour alertes SOS
- [x] Intégrer notifications avec le déclenchement SOS
- [x] Ajouter sons d'alerte personnalisés pour SOS
- [x] Notifier responders et dispatchers automatiquement
- [x] Ajouter gestion des permissions de notification
- [x] Tester les notifications push (27 tests passés)

## Phase 9: Interactive Map
- [x] Lire documentation expo-maps
- [x] Créer écran carte avec MapView (platform-specific: native + web fallback)
- [x] Ajouter marqueurs pour les responders avec statut
- [x] Ajouter zones d'incidents avec cercles colorés par sévérité
- [x] Implémenter mise à jour en temps réel des positions via WebSocket
- [x] Ajouter légende de la carte (responders, incidents, zones)
- [x] Implémenter centrage automatique sur les incidents actifs
- [x] Ajouter détails d'incident au tap sur un marqueur
- [x] Ajouter filtres (All, Incidents, Units) et barre de statistiques
- [x] Tester la carte interactive (28 tests passés)

## Phase 10: Real GPS Location Tracking
- [x] Lire documentation expo-location
- [x] Créer service de localisation avec gestion des permissions
- [x] Implémenter suivi de position en temps réel (foreground)
- [x] Intégrer GPS réel dans l'écran Map (remplacer données simulées)
- [x] Intégrer GPS réel dans le bouton SOS (position exacte + reverse geocoding)
- [x] Intégrer GPS réel dans Share Location (avec envoi WebSocket)
- [x] Envoyer position via WebSocket aux autres utilisateurs
- [x] Ajouter indicateur de précision GPS
- [x] Gérer les cas d'erreur (permission refusée, GPS désactivé, fallback)
- [x] Tester l'intégration GPS (20 tests passés)

## Phase 11: Background Location Tracking
- [x] Lire documentation expo-task-manager et expo-location background
- [x] Demander permissions de localisation en arrière-plan
- [x] Créer background task pour suivi de position (talion-background-location)
- [x] Intégrer background tracking dans LocationService
- [x] Activer automatiquement pour les responders en service (role-gated)
- [x] Envoyer position en arrière-plan via API/WebSocket
- [x] Ajouter indicateur UI de tracking actif (bouton BG Tracking)
- [x] Gérer les cas d'erreur (permission refusée, batterie faible)
- [x] Configurer app.json avec expo-location plugin (iOS + Android background)
- [x] Tester le background location tracking (17 tests passés)

## Phase 5b: Web Admin Console (Dashboard navigateur)
- [x] Créer dashboard web admin accessible via navigateur (HTML/CSS/JS)
- [x] Ajouter endpoints REST API pour données admin (users, incidents, audit)
- [x] Implémenter gestion des utilisateurs web (liste, rôles, suspension)
- [x] Implémenter gestion des incidents web (liste, filtres, détails)
- [x] Créer tableau de bord analytics web (métriques, graphiques)
- [x] Ajouter logs d'audit web (filtrage, historique)
- [x] Servir le dashboard via le serveur Express existant

## Intégration serveur Express
- [x] Configurer le démarrage automatique du serveur Express (port 3000) avec le projet
- [x] Console admin web accessible sans action manuelle

## Console Web Dispatch + Login par rôle
- [x] Créer console web Dispatch (HTML/CSS/JS) avec mêmes fonctions que l'onglet Dispatch de l'app
- [x] Gestion des alertes actives (liste, acknowledge, assign, resolve)
- [x] Suivi des responders en temps réel (statut, localisation)
- [x] Envoi de broadcasts de zone
- [x] Ajouter endpoints REST API pour les données dispatch (6 endpoints)
- [x] Créer page de login par rôle (admin → console admin, dispatcher → console dispatch)
- [x] Unifier la navigation entre les deux consoles web (cross-links dans les sidebars)

## WebSocket temps réel sur consoles web
- [x] Ajouter client WebSocket à la console Dispatch (incidents, responders, broadcasts en temps réel)
- [x] Ajouter client WebSocket à la console Admin (dashboard, audit logs en temps réel)
- [x] Remplacer le polling par des mises à jour instantanées via WebSocket (polling réduit à 30s en fallback)
- [x] Ajouter indicateur de connexion WebSocket sur les deux consoles (⚡ Real-time / ⏳ Connecting / ❌ Offline)
- [x] Ajouter toast notifications en temps réel (nouveaux incidents, acknowledgements, broadcasts)
- [x] Reconnexion automatique avec backoff exponentiel (2s → 30s max)
- [x] Keepalive ping toutes les 25s

## Carte interactive console Dispatch
- [x] Ajouter onglet Map à la console Dispatch avec Leaflet.js + CartoDB Dark Matter tiles
- [x] Afficher les incidents sur la carte avec marqueurs colorés par sévérité + pulse pour critiques
- [x] Afficher les responders sur la carte avec statut (available, on_duty, off_duty)
- [x] Afficher les utilisateurs connectés sur la carte (7 users/dispatchers/admins)
- [x] Ajouter filtres par type (incidents, responders, users) avec checkboxes
- [x] Intégrer les mises à jour temps réel WebSocket sur la carte
- [x] Ajouter popups interactifs avec détails et actions (ACK, Assign, Resolve)
- [x] Ajouter légende couleur et endpoints REST /dispatch/map/users et /dispatch/map/all

## Géofencing visuel sur carte Dispatch
- [x] Ajouter mode dessin de zone sur la carte (clic pour placer le centre, marqueur déplaçable)
- [x] Afficher cercle de rayon interactif avec slider (0.5-25km) + auto-fit carte
- [x] Formulaire de broadcast intégré dans le panneau overlay (sévérité, message, stats)
- [x] Envoyer broadcast depuis la zone dessinée via API REST
- [x] Afficher les zones de broadcast actives sur la carte (cercles + labels)
- [x] Gestion des zones (panneau Active Zones, focus, supprimer)
- [x] Compter les entités dans la zone en temps réel (6 incidents, 3 responders, 6 users, surface km²)

## Alertes automatiques géofencing (entrée/sortie de zone)
- [x] Détecter quand un responder entre dans une zone de géofencing active (haversine distance check)
- [x] Détecter quand un responder sort d'une zone de géofencing active
- [x] Envoyer alerte WebSocket en temps réel (geofenceEntry / geofenceExit)
- [x] Afficher toast notification sur la console Dispatch lors d'entrée/sortie
- [x] Ajouter panneau Geofence Events avec log d'événements (entrées/sorties avec timestamps)
- [x] Marqueur visuel clignotant sur le responder qui entre/sort de la zone (flash vert/rouge)
- [x] Persister les zones de géofencing côté serveur (CRUD API + tracking responderZoneState)
- [x] Ajouter panneau Simulate Movement pour tester entrées/sorties depuis l'UI
- [x] Ajouter entrées d'audit automatiques pour chaque événement de géofencing
- [x] Charger zones et événements depuis le serveur au démarrage de la carte

## Alertes sonores géofencing sur console web
- [x] Générer sons d'alarme via Web Audio API (pas de fichiers audio nécessaires)
- [x] Son différent par sévérité (critical=sirène urgente, high=alarme rapide, medium=bip double, low=bip simple)
- [x] Son différent pour entrée (montant) vs sortie (descendant)
- [x] Bouton mute/unmute (🔊 Sound ON / 🔇 Sound OFF) pour désactiver les sons
- [x] Intégrer les sons avec les événements WebSocket geofenceEntry/geofenceExit
- [x] Fix: normalisation center {lat,lng} → {latitude,longitude} pour détection géofencing

## Notifications navigateur (Web Push)
- [x] Demander permission de notification navigateur au chargement des consoles (auto-init)
- [x] Envoyer notification navigateur pour nouveaux incidents (Admin + Dispatch)
- [x] Envoyer notification navigateur pour événements géofencing (entrée/sortie)
- [x] Envoyer notification navigateur pour broadcasts de zone
- [x] Envoyer notification navigateur pour changements de statut critiques (user offline)
- [x] Ajouter bouton 🔔/🔕 activer/désactiver les notifications dans la toolbar (les deux consoles)
- [x] Clic sur notification ramène au bon onglet (window.focus)
- [x] requireInteraction pour sévérité critical/high, auto-close 10s pour les autres
- [x] Notifications envoyées uniquement quand l'onglet n'est pas au premier plan

## Mode sombre/clair consoles web
- [x] Créer système de variables CSS custom properties pour les deux thèmes (Dispatch + Admin)
- [x] Implémenter thème clair (light) pour la console Dispatch (fond blanc, cards blanches, texte sombre)
- [x] Implémenter thème clair (light) pour la console Admin (fond gris clair #f1f5f9, cards blanches)
- [x] Ajouter bouton toggle 🌙 Dark / ☀️ Light dans la toolbar des deux consoles
- [x] Persister le choix du thème dans localStorage (indépendant par console)
- [x] Détecter la préférence système (prefers-color-scheme: dark)
- [x] Adapter la carte Leaflet au thème clair (tuiles CartoDB Positron) + thème sombre (CartoDB Dark Matter)
- [x] Fix: logique JS admin inversée pour correspondre au CSS (:root=light, [data-theme=dark]=dark)

## Bug Fix: AsyncStorage natif
- [x] Fix erreur "Native module is null, cannot access legacy storage" - downgrade @react-native-async-storage/async-storage de v3.0.1 à v2.2.0 (version recommandée pour Expo SDK 54)
- [x] Vérifié tous les fichiers utilisant AsyncStorage (auth-context, index, admin, messaging-context, notification-service) - imports corrects

## Bug Fix: SOS alertes non reçues par Dispatch
- [x] Fix le bouton SOS de l'app qui n'envoie pas les alertes à la console Dispatch
- [x] Vérifier le flux complet: SOS button → WebSocket → serveur → broadcast → console web Dispatch
- [x] Créer WebSocketProvider pour connecter wsManager au démarrage de l'app
- [x] Permettre au rôle 'user' d'envoyer des alertes SOS (pas seulement dispatcher/responder)
- [x] Utiliser le contexte de connexion comme fallback côté serveur
- [x] Bridger les événements wsManager vers l'ancien websocketService pour compatibilité
- [x] Tests unitaires du flux SOS → WebSocket → Dispatch (9 tests passés)

## Bug Fix: SOS alertes toujours non reçues par Dispatch (2ème investigation)
- [x] Vérifier les logs serveur pour traces d'alerte SOS reçue → log confirme "WebSocket not connected, alert only sent locally"
- [x] Vérifier que le WebSocketProvider se connecte réellement sur le téléphone → ws://localhost:3000 ne fonctionne pas sur un vrai appareil
- [x] Vérifier l'URL WebSocket utilisée par l'app mobile (localhost vs URL publique) → CAUSE RACINE: localhost pointe vers le téléphone, pas le serveur
- [x] Corriger le flux SOS → WebSocket → serveur → Dispatch → créé lib/server-url.ts avec résolution dynamique de l'URL
- [x] Ajouté setUrl() aux deux services WebSocket (wsManager + websocketService)
- [x] Mis à jour api.ts pour utiliser getApiBaseUrl() au lieu de localhost hardcodé
- [x] 27 tests passés (18 URL resolution + 9 SOS flow)

## Bug Fix: SOS alertes TOUJOURS non reçues par Dispatch (3ème investigation)
- [x] Vérifier les logs serveur → confirme "WebSocket not connected, alert only sent locally" à chaque appui SOS
- [x] Diagnostic: WebSocket ne se connecte jamais depuis Expo Go (localhost + proxy issues)
- [x] Solution: Remplacer WebSocket par HTTP POST comme méthode PRIMAIRE pour l'envoi SOS
- [x] Ajouté POST /api/sos sur le serveur → crée l'alerte + broadcastMessage vers tous les clients WS (Dispatch)
- [x] Réécrit SOS button pour utiliser fetch() + getApiBaseUrl() au lieu de wsManager
- [x] Ajouté userId prop au SOSButton et passé depuis le home screen
- [x] Testé endpoint via curl (localhost + URL publique) → success + broadcast confirmé
- [x] 35 tests passés (17 REST SOS + 18 URL resolution)

## Migration AlertCreationModal vers REST API
- [x] Lire et comprendre le flux actuel du AlertCreationModal (useWebSocket)
- [x] Remplacer useWebSocket par un appel HTTP POST /api/sos via getApiBaseUrl()
- [x] Supprimer la dépendance au WebSocket pour la création d'alertes
- [x] Ajouté userId/userName props + passés depuis le home screen
- [x] Ajouté checkServerHealth() pour vérifier la connectivité au serveur
- [x] Le bouton Submit n'est plus bloqué par l'état WebSocket
- [x] Tester le nouveau flux avec vitest → 27 tests passés (10 modal + 17 SOS REST)

## Bug Fix: Les alertes ne sont pas visibles dans l'app
- [x] Vérifier comment le Home screen récupère les alertes → données mock hardcodées + WebSocket non connecté
- [x] Vérifier comment le Dispatcher screen récupère les alertes → données mock locales uniquement
- [x] Créé hook useAlerts avec polling REST API (GET /alerts) + gestion d'erreurs
- [x] Home screen: remplacé mock data par useAlerts (polling 10s) + refresh après SOS
- [x] Dispatcher screen: remplacé mock data par useAlerts (polling 5s) + refresh button + error banner
- [x] 19 tests passés (6 useAlerts + 7 Home + 6 Dispatcher)

## Notifications push SOS + Filtrage alertes par rôle
- [x] Notifications push aux dispatchers/responders quand un SOS arrive (même app en arrière-plan)
- [x] Filtrer les alertes SOS pour qu'elles n'apparaissent QUE pour les dispatchers (pas les users)
- [x] Lire la doc Expo notifications et le server README pour comprendre le setup actuel
- [x] Implémenter l'envoi de push notifications côté serveur lors d'un SOS (sendPushToDispatchersAndResponders)
- [x] Enregistrer le push token des dispatchers/responders côté serveur (POST /api/push-token + usePushNotifications hook)
- [x] Migré onglet dispatcher (tabs) vers REST API useAlerts au lieu de mock data + websocketService
- [x] Filtrage défensif: rôles non-privilégiés (user + undefined) ne voient pas les SOS
- [x] Tester le flux complet → 15 tests passés (7 filtering + 4 push token + 2 SOS + 2 GET alerts)

## Acknowledge/Resolve côté serveur + Détails incident console Dispatch
- [x] Ajouter GET /alerts/:id pour détails complets (location GPS, respondingDetails)
- [x] Ajouter PUT /alerts/:id/acknowledge côté serveur (change status + broadcast)
- [x] Ajouter PUT /alerts/:id/resolve côté serveur (change status + broadcast)
- [x] Ajouter modal de détails d'incident dans la console web Dispatch (HTML + CSS + JS)
- [x] Inclure mini-carte Leaflet avec marqueur pulsant + cercle de rayon + tuiles adaptées au thème
- [x] Afficher toutes les infos (type, sévérité, description, créateur, timestamp, responders assignés)
- [x] Ajouter boutons Acknowledge/Assign Unit/Resolve dans le modal de détails
- [x] Incidents cliquables dans Overview et Incidents tab + bouton View Details
- [x] Tester les endpoints → 7 tests passés (GET detail, 404, ACK, resolve)

## Visibilité alertes acknowledged + Responders toujours visibles + Sons d'alerte
- [x] Les alertes "acknowledged" restent visibles (GET /alerts retourne active + acknowledged, exclut resolved)
- [x] Les responders toujours visibles sur la carte et dans les listes (déjà le cas dans la console Dispatch)
- [x] Sons d'alerte console Dispatch: SOS siren (4 cycles sawtooth), critical/high/medium/low beeps, ACK/resolve sounds
- [x] Sons d'alerte app mobile: useAlerts playSounds option, détection de nouvelles alertes par comparaison d'IDs
- [x] 12 tests passés (visibility, sounds, role filtering)

## Messagerie complète mobile ↔ console Dispatch
- [x] Analyser le code de messagerie existant (mobile + serveur + console web)
- [x] Ajouter tags de profil utilisateur (modèle + endpoints + UI profil)
- [x] Créer endpoints REST serveur pour messagerie (POST /api/messages, GET /api/conversations, etc.)
- [x] Créer système de groupes/canaux (par sélection d'utilisateurs, par rôle, par tags)
- [x] Broadcast WebSocket des messages en temps réel (newMessage event)
- [x] Chat 1-à-1 entre utilisateurs mobiles et dispatch
- [x] Chat de groupe par sélection d'utilisateurs
- [x] Chat de groupe par rôle (ex: tous les dispatchers, tous les responders)
- [x] Chat de groupe par tags de profil (ex: tag "équipe-alpha", "zone-nord")
- [x] Mettre à jour l'écran Messages de l'app mobile pour supporter 1-à-1 et groupes
- [x] Ajouter panneau de messagerie à la console web Dispatch
- [x] Notifications de nouveaux messages (son + badge)
- [x] Tester le flux complet de messagerie

## Améliorations dispatcher mobile + indicateur connexion
- [x] Acknowledge incidents depuis l'onglet dispatcher mobile → appel serveur PUT /alerts/:id/acknowledge + refresh
- [x] Resolve incidents depuis l'onglet dispatcher mobile → appel serveur PUT /alerts/:id/resolve + refresh
- [x] Indicateur de connexion serveur sur l'écran d'accueil (vert "Connected" / rouge "Server offline")
- [x] Confirmation SOS toast déjà implémentée (Alert.alert "SOS Activated" / "SOS Activated (Offline)")

## Gestion complète des utilisateurs - Console Admin
- [x] Endpoints serveur CRUD utilisateurs (POST/PUT/DELETE /admin/users)
- [x] Modèle utilisateur complet (nom, prénom, email, adresse, tél fixe/mobile, tags, rôle, commentaires, photo, relations)
- [x] UI liste des utilisateurs dans la console Admin avec recherche/filtrage
- [x] Formulaire ajout/édition utilisateur avec tous les champs
- [x] Autocomplétion adresse (Nominatim/OpenStreetMap)
- [x] Upload photo de profil (sélecteur dans le formulaire)
- [x] Gestion des relations entre utilisateurs (parenté, même adresse)
- [x] Affichage rapide famille / utilisateurs même adresse
- [x] Suppression d'utilisateurs avec confirmation
- [x] Recherche et filtrage des utilisateurs par nom, rôle, tag

## Authentification email + mot de passe
- [x] Ajouter champ mot de passe au modèle utilisateur serveur
- [x] Ajouter champ mot de passe dans le formulaire Admin console (création/édition)
- [x] Hasher les mots de passe côté serveur (bcrypt)
- [x] Créer endpoint POST /auth/login (email + mot de passe)
- [x] Mettre à jour l'écran de login mobile pour utiliser email + mot de passe
- [x] Stocker le token/session après connexion réussie
- [x] Tester le flux d'authentification complet

## Historique de connexion
- [x] Stocker les tentatives de connexion côté serveur (timestamp, IP, user-agent, statut)
- [x] Endpoint GET /admin/users/:id/login-history
- [x] Endpoint GET /admin/login-history (global)
- [x] Section historique de connexion dans la console Admin (par utilisateur + vue globale)
- [x] Afficher date/heure, IP, appareil, statut (succès/échec)
- [x] Filtrage et pagination de l'historique
- [x] Tests de l'historique de connexion

## Profil utilisateur sur la carte Dispatch
- [x] Afficher le profil complet d'un utilisateur quand on clique sur son marqueur dans la carte dispatch
- [x] Inclure : photo, nom, prénom, rôle, statut, email, téléphones, adresse, tags, relations, commentaires
- [x] Boutons d'action rapide (envoyer message, appeler, voir historique connexion)

## Noms sur les marqueurs + Recherche carte
- [x] Afficher nom/prénom à côté de chaque marqueur utilisateur sur la carte Dispatch
- [x] Afficher nom/prénom à côté de chaque marqueur responder sur la carte Dispatch
- [x] Afficher nom/prénom à côté de chaque marqueur sur la carte mobile
- [x] Ajouter barre de recherche d'utilisateur sur la carte Dispatch (localiser + centrer)

## Parité fonctionnelle Dispatch web → mobile
- [x] Connecter le broadcast mobile au serveur (POST /broadcast + historique)
- [x] Récupérer les données responders en temps réel depuis le serveur
- [x] Ajouter vue profil utilisateur dans l'app mobile (composant réutilisable)
- [x] Ajouter barre de recherche utilisateur sur la carte mobile
- [x] Connecter l'onglet Admin mobile aux vrais endpoints serveur (CRUD users, login history, audit)
- [x] Ajouter gestion des geofences sur la carte mobile
- [x] Ajouter bouton "Message" rapide depuis le dispatcher mobile

## Admin mobile - CRUD utilisateurs (serveur)
- [x] Connecter l'onglet Admin mobile aux vrais endpoints serveur (GET /admin/users)
- [x] Formulaire d'ajout d'utilisateur dans l'app mobile (nom, prénom, email, mot de passe, rôle, tags, téléphones, adresse, commentaires)
- [x] Formulaire d'édition d'utilisateur dans l'app mobile
- [x] Suppression d'utilisateur avec confirmation dans l'app mobile
- [x] Recherche/filtrage des utilisateurs dans l'app mobile
- [x] Affichage des relations et profil complet dans l'app mobile

## Geofences sur la carte mobile
- [x] Afficher les geofences existantes sur la carte mobile (cercles/polygones)
- [x] Créer une nouvelle geofence depuis la carte mobile (nom, rayon, type)
- [x] Modifier une geofence existante (nom, rayon, position)
- [x] Supprimer une geofence depuis la carte mobile
- [x] Synchroniser les geofences avec le serveur (GET/POST/PUT/DELETE /geofences)

## Upload photo de profil
- [x] Endpoint serveur pour upload de photo (POST /admin/users/:id/photo)
- [x] Sélecteur de photo dans le formulaire utilisateur mobile (expo-image-picker)
- [ ] Upload et affichage de la photo dans le formulaire web Admin
- [x] Afficher la photo de profil dans les listes d'utilisateurs et profils

## Relations dans le formulaire Admin mobile
- [x] Ajouter section relations dans le formulaire d'ajout/édition utilisateur mobile
- [x] Sélection d'utilisateur existant pour créer une relation (conjoint, parent, enfant, etc.)
- [x] Afficher les relations existantes avec possibilité de supprimer

## Mode hors-ligne (Offline Mode)
- [x] Créer service de cache offline (AsyncStorage) avec TTL et invalidation
- [x] Mettre en cache les alertes/incidents (GET /alerts) avec fallback offline
- [x] Mettre en cache les contacts/utilisateurs (GET /admin/users) avec fallback offline
- [x] Mettre en cache les geofences (GET /dispatch/geofence/zones) avec fallback offline
- [x] Mettre en cache les conversations/messages récents
- [x] Ajouter indicateur de mode offline sur l'écran d'accueil (bannière/badge)
- [x] Ajouter indicateur de dernière synchronisation (timestamp)
- [x] Queue les actions offline (SOS, messages) pour envoi automatique à la reconnexion
- [x] Tester le mode offline (22 tests passés)

## Bugs
- [x] Bannière "Offline Mode" s'affiche alors que le serveur est en ligne (faux positif) → corrigé: utilise getApiBaseUrl() + ne persiste pas l'état offline
- [x] Share Location d'un user mobile n'apparaît pas sur la carte Dispatch → corrigé: envoi périodique via WS + broadcast userLocationUpdate + handler dispatch
- [x] Share Location toujours pas visible sur la carte Dispatch → corrigé: REST fallback POST /api/location + création auto user dans la map serveur + envoi périodique avec ref fraîche + dispatch console updateUserMarkers direct
- [x] Share Location TOUJOURS pas visible → corrigé: ref pattern pour closures stales, serveur tolérant userId vide, port 3000 exposé publiquement, noms réels dans map/users
- [x] Quand on arrête le partage de localisation, la position reste sur la carte Dispatch → corrigé: DELETE /api/location + broadcast userLocationRemoved + dispatch handler
- [x] Ajouter bouton "Localiser" dans la fiche utilisateur de la console Dispatch pour centrer la carte sur un user
- [x] La localisation continue d'être affichée sur la carte Dispatch après l'arrêt du partage → corrigé: POST /api/location/stop + users.delete() au lieu de location=undefined + dispatch handler userLocationRemoved
- [x] Marqueur localisation PERSISTE toujours sur carte Dispatch → corrigé: race condition dans le hook WS qui déclenchait refreshMapData après userLocationRemoved, recréant le marqueur. Retiré userLocationUpdate/Removed de la liste des events qui trigger refreshMapData.
- [x] Marqueur localisation PERSISTE ENCORE → corrigé: sharingUserIdRef pour tracker le vrai userId serveur + TTL cleanup 30s côté serveur (auto-suppression si plus de mise à jour) + stop signal fiable avec userId garanti
- [x] Compteur "utilisateurs en direct" sur la carte Dispatch (nombre de personnes partageant leur position en temps réel)

## Bugs
- [x] Les alertes broadcast envoyées depuis la console Dispatch ne sont pas reçues par l'app mobile
- [x] Les notifications push broadcast ne sont pas reçues sur l'app mobile
- [x] Notification locale + son sur l'app quand une alerte broadcast arrive (via polling ou WS)
- [x] Les users ne peuvent pas prendre/ACK une alerte broadcast, uniquement la consulter. Seuls les responders peuvent la prendre.
- [x] Créer des incidents (medical, fire, accident, etc.) depuis la console Dispatch, avec notification + son sur l'app mobile
- [x] Le preview ne s'affiche pas dans le panneau de gestion (sandbox redémarrage, résolu)
- [x] Console indique 504 Gateway Time-out sur les requêtes API
- [x] Son de sirène pour les notifications d'alerte dans l'app (remplacer le son actuel)
- [x] Nouvelles catégories d'incidents : Accident, Home-Jacking, Cambriolage, Médical, Feu, Animal perdu, Événement climatique, Rodage, Véhicule suspect, Fugue, Route bloquée, Route fermée
- [x] Autocomplétion d'adresse Nominatim/OpenStreetMap lors de la création d'incidents (dispatch console)
- [x] Bug: Autocomplétion d'adresse ne fonctionne pas dans la console Dispatch (corrigé: proxy serveur /api/geocode pour contourner CORS/403 Nominatim)
- [x] Bug: Son de sirène ne fonctionne pas dans l'app mobile (corrigé: service réécrit avec createPlayer frais + initialize() avant chaque play)
- [x] Bug: Autocomplétion d'adresse ne fonctionne toujours pas dans la console Dispatch (corrigé: API_BASE + getWsUrl() redirigent vers port 3000 quand accédé depuis un proxy différent)
- [x] Bug: Autocomplétion d'adresse et catégories d'incidents toujours pas visibles sur la console Dispatch (corrigé: CDN cache bypass via /dispatch-v2/ + fichiers versionnés app.v2.js/styles.v2.css + login redirige vers /dispatch-v2/)
- [x] Bug: Autocomplétion d'adresse limitée à la France uniquement, doit couvrir le monde entier (corrigé: le filtre countrycodes=fr avait déjà été retiré du proxy /api/geocode, résultats mondiaux confirmés)
- [x] Bug: La page de login console ne s'affiche pas (corrigé: le serveur n'avait pas été redémarré après ajout des routes /console-login/ et /console/, maintenant fonctionnel)
- [x] Bug: L'app mobile ne s'ouvre plus (corrigé: expo-audio v55, expo-notifications v55, expo-device v55 étaient incompatibles avec Expo SDK 54, rétrogradés aux versions correctes ~1.1.1, ~0.32.16, ~8.0.10)
- [x] Bug: L'app mobile ne s'ouvre toujours pas dans Expo Go (corrigé: erreur 502 proxy causée par timeout lors de la compilation à froid du bundle JS, résolu par pré-chauffage du cache Metro)
- [x] Location visibility: regular users cannot see other users' locations (implémenté: isPrivileged check côté client, responders/geofences masqués pour les users)
- [x] Location visibility: only responders/dispatchers can see all user locations (implémenté: filtres, stats bar, FAB, légende adaptés par rôle)
- [x] Location visibility: family members (parents, children, siblings) can see each other (implémenté: getFamilyMemberIds() serveur + /api/family/locations endpoint + familyLocationUpdate WebSocket + marqueurs famille sur carte)
- [x] Family relationship data model (server-side) (implémenté: relationships bidirectionnelles parent/child/sibling/spouse dans adminUsers, getReciprocalRelType helper)
- [x] User profile: verify family connections display and management (vérifié: profils admin affichent relations enrichies, dispatcher profile modal affiche relations, 19 tests passés)

## Écran "Ma Famille"
- [x] Créer un nouvel onglet/écran "Ma Famille" dans l'app mobile (onglet avec 3 sous-onglets: Membres, Périmètres, Alertes)
- [x] Afficher la liste des membres de la famille avec photo, nom, relation (statut en ligne/hors ligne, dernière position)
- [x] Afficher la dernière position connue de chaque membre (avec timestamp relatif)
- [x] Afficher l'historique des positions des membres de la famille (modal avec liste chronologique)
- [x] Permettre d'ajouter/supprimer des liens familiaux depuis l'écran (formulaire de création de périmètre)
- [x] Endpoint serveur pour l'historique des positions familiales (GET /api/family/location-history)

## Notifications de proximité familiale
- [x] Définir un périmètre de sécurité par membre de la famille (rayon en mètres, 50m-50km)
- [x] Détecter quand un membre sort du périmètre défini (serveur-side, checkFamilyPerimeters avec haversine)
- [x] Envoyer une notification push + alerte in-app quand un enfant sort du périmètre (WebSocket proximityAlert + push notification)
- [x] Afficher le périmètre sur la carte (sous-onglet Périmètres avec liste des zones actives)
- [x] Endpoint serveur CRUD pour les périmètres familiaux (GET/POST/PUT/DELETE /api/family/perimeters)
- [x] Historique des alertes de proximité (GET /api/family/proximity-alerts + sous-onglet Alertes)

## Persistance des alertes en base de données
- [x] Lire server/README.md pour comprendre le setup DB existant (pas de DB configurée, utilisation JSON file persistence)
- [x] Créer la persistance fichier JSON pour alertes/incidents (data/alerts.json avec debounced save)
- [x] Persister la création d'alertes (POST /api/sos) → persistAlerts() après chaque mutation
- [x] Persister la lecture d'alertes (GET /alerts) → chargement au démarrage depuis fichier
- [x] Persister les mises à jour d'alertes (PUT /alerts/:id/acknowledge, resolve) → persistAlerts()
- [x] Conserver le broadcast WebSocket en temps réel après persistance (inchangé)
- [x] Persister aussi périmètres familiaux, alertes de proximité, et historique de localisation
- [x] Tester la persistance → 31 tests passés (family-features.test.ts)
- [x] Bug: L'écran de login ne s'affiche pas au lancement de l'app (corrigé: remplacé initialRouteName par useRouter+useSegments redirect dans _layout.tsx)
- [x] Ajouter un bouton de déconnexion visible sur l'écran d'accueil (ajouté dans la status card avec confirmation Alert)
- [x] Autocomplétion d'adresse dans le formulaire de création de périmètre familial (implémenté: /api/geocode Nominatim avec debounce 400ms, sélection met à jour le centre du périmètre, 5 tests passés)
- [x] Mini-carte dans le formulaire de périmètre pour visualiser le centre et le rayon avant confirmation (implémenté: NativeMapView avec Marker + Circle, fallback web avec coordonnées, zoom auto selon rayon)
- [x] Bouton "Utiliser ma position actuelle" dans le formulaire de périmètre pour centrer sur la localisation GPS du parent (implémenté: useLocation().getCurrentPosition() + reverseGeocode + haptic feedback, 7 tests passés)
- [x] Visibilité onglets par rôle: utilisateurs simples ne voient PAS Admin ni Dispatch (implémenté: href:null sur Dispatch et Admin)
- [x] Visibilité onglets par rôle: dispatchers voient Dispatch mais PAS Admin (implémenté: canSeeDispatch = dispatcher || admin)
- [x] Visibilité onglets par rôle: admins voient tout (Admin + Dispatch) (implémenté: canSeeAdmin = admin, 6 tests passés)
- [x] Masquer Messages et PTT pour les utilisateurs simples (implémenté: href:null pour Messages et PTT quand role=user, 9 tests passés)
- [x] Créer un écran de profil utilisateur éditable (implémenté: onglet Profil avec prénom, nom, téléphone mobile, photo, rôle, tags, déconnexion, updateProfile via PUT /admin/users/:id)
- [x] Messages et PTT doivent être visibles pour TOUS les utilisateurs (implémenté: supprimé canSeeMessaging, Messages et PTT sans href:null, 9 tests passés)
- [x] Remplacer toutes les adresses parisiennes par des lieux réels à Genève (implémenté: users, incidents, audit, responders, map, location-service default, dispatch web, family screen, tests — Champel, Florissant, Malagnou, Vésenaz)
- [x] Zones géographiques prédéfinies (Champel, Florissant, Malagnou, Vésenaz) comme filtres rapides sur la carte Dispatch (implémenté: boutons zone-filter avec zoom, polygones de limites communales colorés, labels)
- [x] Fond de carte OpenStreetMap centré sur Genève avec limites des communes visibles (implémenté: center [46.1950, 6.1580] zoom 14, polygones Champel/Florissant/Malagnou/Vésenaz avec bordures en pointillés)
- [x] Points d'intérêt genevois (hôpitaux, casernes, postes de police) comme lieux de référence pour les incidents (implémenté: 8 POIs sur la carte + boutons quick-select dans le modal de création d'incident + toggle POI)
- [x] Vérifier et corriger toutes les adresses/coordonnées restantes à Paris dans tout le code (corrigé: dispatch app.js center, KNOWN_COORDS x2, default incident coords, simulation coords — 0 référence Paris restante dans server/app/services/lib/components)
- [x] Quand on clique sur Resolve sur un incident de la carte Dispatch, il doit disparaître immédiatement de la carte (implémenté: filtre status !== 'resolved' dans updateIncidentMarkers + updateGeofenceStats, refreshMapData déclenché par alertResolved WS)
- [x] Bug: Des incidents apparaissent toujours vers Paris sur la carte Dispatch (corrigé: supprimé data/alerts.json et data/family-perimeters.json avec anciennes coordonnées Paris, serveur redémarré pour regénérer les données seed Genève, data/ ajouté au .gitignore)
- [x] Rapport de ronde: API serveur (CRUD, persistance, types TypeScript — POST/GET/GET:id + persist patrolReports.json)
- [x] Rapport de ronde: Écran mobile de création (date/heure auto, lieu dropdown, 6 statuts colorés, 5 tâches OK/PAS OK, champ texte "autre", notes)
- [x] Rapport de ronde: Écran mobile de consultation (liste avec filtres par statut, vue détaillée avec tâches/médias/notes)
- [x] Rapport de ronde: Section dans la console Dispatch (onglet Rondes, grille de rapports, stats, filtres, modal détail, auto-refresh)
- [x] Rapport de ronde: Alerte automatique aux dispatchers/admins si statut non-vert (WebSocket patrolAlert + push notifications + toast dispatch)
- [x] Rapport de ronde: Accès restreint aux responders, dispatchers et admins (vérification côté serveur + écran verrouillé côté mobile)
- [x] Rapport de ronde: Possibilité de prendre/attacher une photo ou vidéo (expo-image-picker caméra + galerie, upload multer, affichage dans détails)
- [x] Bug: La console Dispatch ne répond plus (corrigé: variable origSwitchTab déclarée en double dans app.js — fusionné les hooks de tab switching messages + patrol en un seul bloc)
- [x] Bug: Vésenaz n'apparaît pas sur la carte Dispatch quand on sélectionne toutes les zones (corrigé: centre carte recalculé à [46.2125, 6.1795] pour englober les 4 communes, zoom initial et 'all' passés de 14 à 13)
- [x] PTT opérationnel: Canaux de communication (4 canaux par défaut: Urgence, Dispatch, Intervenants, Général avec rôles filtrés)
- [x] PTT opérationnel: Enregistrement audio et envoi via WebSocket (expo-audio recording + base64 + WS pttTransmit + REST fallback)
- [x] PTT opérationnel: Réception et lecture audio en temps réel (WS pttMessage + AudioPlayer base64 playback)
- [x] PTT opérationnel: Interface mobile avec sélection de canal et bouton PTT (horizontal channel list, PTT button, message history, waveform)
- [x] PTT: Dispatch et admin peuvent créer des groupes/canaux PTT personnalisés (modal création groupe, API CRUD, suppression par long press, 21 tests passés)
- [x] Bug: L'app ne s'ouvre plus (corrigé: shadowing de Audio par import expo-audio dans ptt-context.tsx — renommé en ExpoAudio + globalThis.Audio pour web playback)
- [x] PTT: Intégrer le PTT dans la console Dispatch web (écoute + transmission depuis le navigateur, CSS + JS complet avec enregistrement/lecture/canaux/historique)
- [x] PTT: Indicateur "en train de parler" en temps réel sur l'écran PTT mobile (nom + rôle de l'émetteur, déjà implémenté dans ptt.tsx lignes 300-312)
- [x] PTT: Mode "urgence" qui interrompt tous les canaux pour diffuser un message prioritaire (déjà implémenté: overlay urgence, bouton emergency, pttEmergency WS)
- [x] PTT: Bouton PTT dans le profil utilisateur quand une alerte SOS est active (bannière SOS rouge avec bouton Communication PTT → canal urgence)
- [x] Bug: PTT recording crash on native — "Cannot read property 'prototype' of undefined" in ptt-context.tsx startRecording (corrigé: remplacé dynamic import + new AudioRecorder() par require() statique + useAudioRecorder hook)
- [x] Bug: Les messages PTT ne passent pas entre l'app mobile et la console dispatch (corrigé: normalisation base64 — strip data URL prefix à l'envoi dispatch, ajout prefix pour lecture HTML audio, types WS manquants ajoutés dans websocket-manager.ts)
- [x] Bug: Les incidents en cours ne s'affichent pas sur la carte de l'app mobile (corrigé: ajout fetch REST /alerts au montage + polling 15s, suppression MOCK_INCIDENTS comme défaut, écoute wsManager newAlert/alertResolved pour mise à jour temps réel, fix sendLocation)
- [x] Feature: Tap sur incident de la carte → panneau détails avec actions (acknowledge, navigate, contact dispatch) — app mobile
- [x] Feature: Filtre par type d'incident sur la carte (SOS, médical, incendie, etc.) — app mobile
- [x] Feature: Tap sur incident de la carte → panneau détails avec actions (acknowledge, assign, resolve, navigate) — console dispatch
- [x] Feature: Filtre par type d'incident sur la carte (SOS, médical, incendie, sécurité, accident, danger, broadcast) — console dispatch
- [x] Bug: Le preview ne se charge pas, l'app ne s'ouvre pas, et la console dispatch ne se charge pas (résolu par redémarrage serveur)
- [x] Bug/Feature: Console dispatch — le modal "Assign Unit" corrigé: affiche maintenant les vrais responders (noms, téléphone, tags, statut connecté) au lieu d'unités génériques. Labels renommés en "Assigner Responder"
- [x] Feature: Le dispatch doit pouvoir changer le statut des responders (disponible, en service, hors service, en intervention) — dropdown select sur chaque carte responder + endpoint PUT /dispatch/responders/:id/status + toast notification + filtre 'En intervention' ajouté
- [x] Feature: Cohérence relation responder ↔ incident — Console dispatch: cartes responders affichent incidents assignés
- [x] Feature: Cohérence relation responder ↔ incident — Console dispatch: détails incident affichent vrais noms responders
- [x] Feature: Cohérence relation responder ↔ incident — Console dispatch: liste incidents affiche noms responders (pas juste IDs)
- [x] Feature: Cohérence relation responder ↔ incident — App mobile: vue incidents affiche noms responders assignés (home, dispatcher, map)
- [x] Feature: Cohérence relation responder ↔ incident — App mobile: vue responders affiche incidents assignés (dispatcher.tsx enrichi)
- [x] Feature: Cohérence relation responder ↔ incident — API serveur enrichit les données avec cross-références (respondingNames + assignedIncidents)
- [x] Bug: Les messages PTT arrivent sur le dispatch et l'app mais le contenu audio est vide (pas de voix) — corrigé: ajout champ mimeType (audio/m4a pour native, audio/webm pour web) dans toute la chaîne PTT (serveur WS/REST, mobile ptt-context.tsx, dispatch console app.v2.js). Chaque côté utilise maintenant le bon MIME type pour la lecture audio. 13 tests mimeType passés.
- [x] Feature: Désassignation de responder — endpoint PUT /dispatch/incidents/:id/unassign côté serveur, bouton ❌ Désassigner dans le modal d'assignation et le détail incident sur la console dispatch, long-press sur les chips assignés dans l'app mobile. Audit trail + broadcast WebSocket. 12 tests passés.
- [x] Feature: Estimation de distance — endpoint GET /dispatch/incidents/:id/responders-nearby avec calcul haversine côté serveur, badge 📍 distance dans le modal d'assignation (console dispatch + app mobile), tri par distance (plus proche en premier), responders sans position affichés en dernier. 12 tests passés.
- [x] Rename: Changer le nom de l'app de "SafeNet" à "Talion Crisis Comm" partout dans le projet (config, console dispatch, app mobile, branding) — renommé dans profile.tsx, server/index.ts User-Agent, tests (emails, user-agent), todo.md header. app.json était déjà correct.
- [x] Bug: Deployment fails - Cannot find module '/usr/src/app/dist/index.js'. Corrigé: ajout esbuild CJS build dans le script build, correction des chemins __dirname vers PROJECT_ROOT pour fonctionner depuis dist/ en production. 9 tests passés.
- [x] Bug: Les "connexions rapides" sur l'écran de login ne fonctionnent pas sur l'APK Android — Corrigé: le problème était que l'APK ne pouvait pas atteindre le serveur (déploiement échoué + server-url.ts fallback vers localhost). Ajout fallback vers le domaine manus.space publié pour les APK standalone.
- [x] Feature: Écran "Mot de passe oublié" — endpoint POST /auth/request-password-reset (génère code 6 chiffres, broadcast aux admins/dispatchers via WebSocket), POST /auth/reset-password (valide code + nouveau mdp). Écran mobile forgot-password.tsx en 2 étapes (email → code+mdp). Lien "Mot de passe oublié ?" ajouté sur login.tsx. 13 tests passés.
- [x] Bug: Caractères Unicode cassés (codes comme uDC65) dans le tableau Admin — corrigé: remplacé toutes les séquences d'échappement \uXXXX par les vrais caractères UTF-8 (emojis + accents français) dans admin.tsx. 3 tests passés.
- [x] Bug: PTT messages n'arrivent pas de l'app mobile à la console dispatch — corrigé: ajout wsClientMap (Map<WebSocket, userId>) pour lookup O(1) dans le broadcast PTT, remplacement du scan linéaire userConnections. Le broadcast inclut maintenant toujours les dispatchers et admins. 4 tests passés.
- [x] Feature: Appels PTT 1-on-1 entre dispatch et utilisateur individuel — endpoint POST /api/ptt/channels/direct crée/retrouve un canal direct entre 2 utilisateurs. Bouton "Direct" sur la console dispatch (modal liste utilisateurs) et sur l'app mobile (bouton violet). Les canaux directs sont affichés en violet avec icône téléphone. Les dispatchers voient tous les canaux directs, les users voient seulement les leurs. 10 tests passés.
- [x] Bug: PTT audio toujours vide — corrections multiples: (1) mimeType audio/m4a → audio/mp4 pour compatibilité navigateur, (2) augmentation retries enregistrement natif de 1s à 6s avec vérification taille fichier, (3) express.json limit 100Ko → 50Mo, (4) WebSocket maxPayload 50Mo, (5) fallback REST automatique si WS échoue, (6) logs diagnostiques complets sur toute la chaîne, (7) meilleure gestion erreurs enregistrement/lecture natif
- [x] Bug: PTT audio ne fonctionne pas sur Expo Go / iPhone — corrigé: (1) remplacé RecordingPresets.HIGH_QUALITY par preset AAC custom qui force .m4a (MPEG4AAC) sur iOS au lieu de .caf, (2) ajout setAudioModeAsync({allowsRecording: false}) après chaque arrêt d'enregistrement pour que iOS route l'audio vers le haut-parleur, (3) extension .m4a pour les fichiers temp de playback natif. 23 tests passés.
- [x] Bug: PTT messages coupés à ~3 secondes — corrigé: (1) remplacé push-to-talk (onPressIn/onPressOut) par mode toggle (tap pour parler, tap pour arrêter) pour éviter les arrêts prématurés quand le doigt glisse, (2) ajout isRecordingRef + pendingStopRef pour gérer les race conditions entre startRecording async et stopRecording, (3) suppression du conflit onPress/onPressIn/onPressOut, (4) bouton agrandi de 100px à 120px, (5) labels PARLER/ARRÊTER plus clairs
- [x] Bug: PTT audio TOUJOURS vide après multiples corrections — ROOT CAUSE FOUND: expo-audio useAudioRecorder hook is a known buggy API that doesn't actually record on many devices. FIX: Completely rewrote native recording to use expo-av Audio.Recording class instead. Added expo-av dependency, removed useAudioRecorder hook, using proven prepareToRecordAsync() + startAsync() + stopAndUnloadAsync() + getURI() lifecycle. Also added RECORD_AUDIO Android permission and microphone permission config. 17 new tests passing.
- [x] Bug: PTT recording fails in Expo Go — "failed to start audio record" error. ROOT CAUSE: expo-av is NOT available in Expo Go (requires native rebuild). FIX: Reverted to expo-audio useAudioRecorder hook (the correct API for Expo Go SDK 54) but with proper audio mode setup: setAudioModeAsync({ allowsRecording: true }) BEFORE prepareToRecordAsync(), and allowsRecording: false AFTER stop() for iOS speaker routing. Also added 100ms flush delay before reading file. 20 tests passing.
- [x] UI: Rendre les IDs d'incidents et informations plus lisibles dans la console dispatch — remplacé les UUIDs par des codes courts INC-XXXX, traduit les labels en français (sévérité, statut, types, boutons d'action), appliqué sur admin.tsx, dispatcher.tsx et explore.tsx. Créé lib/format-utils.ts avec fonctions réutilisables. 27 tests passent.
- [x] Bug: Long UUID IDs still visible in UI — FIXED: The raw UUIDs were displayed in the web dispatch console (app.v2.js) and admin console (app.v2.js), not in the mobile app. Added formatIncidentId(), sevLabel(), statusLabel(), typeLabel() functions to both web consoles. Replaced all visible inc.id/alert.id/report.id with INC-XXXX short codes. Translated badges and buttons to French.
- [x] UI: Refaire le layout des sections Overview et Responders de la console dispatch — Redesigné avec cartes structurées (ov-inc-card, ov-resp-card, fr-card), avatars avec initiales colorées par statut, badges de sévérité/statut, boutons d'action, sections détails. Traduit toute l'interface en français (sidebar, stats, titres, labels de page).
- [x] Bug: Console dispatch n'arrive plus à se connecter au serveur — CAUSE: erreur de syntaxe JS dans app.v2.js ligne 540, les apostrophes françaises dans 'Vue d'ensemble' et 'Unités d'intervention' cassaient les chaînes entre guillemets simples. FIX: remplacé les guillemets simples par des guillemets doubles pour les chaînes contenant des apostrophes.
- [x] Bug: Photos jointes aux alertes depuis l'app mobile ne sont pas visibles dans la console dispatch — ROOT CAUSE: handleSubmitAlert envoyait uniquement le JSON sans les photos. FIX: (1) Ajouté champ photos[] à l'interface Alert serveur, (2) Créé endpoint POST /api/alerts/:id/photos avec multer, (3) App mobile upload les photos après création de l'alerte via FormData, (4) Console dispatch affiche les photos dans le détail d'incident avec galerie cliquable, (5) WebSocket alertPhotosUpdated pour mise à jour en temps réel
- [x] Feature: Ajouter un filtre dans l'app mobile pour les responders — Ajouté des chips de filtre "Tous" / "Mes assignations" sur l'écran d'accueil, visible pour responders/dispatchers/admins. Filtre par user.id dans assignedResponders ou par nom dans respondingNames. Messages vides adaptés au filtre actif. 9 tests passent.
- [x] Feature: Notification push quand un incident est assigné à un responder — Ajouté sendPushToUser dans le endpoint assign, envoie une notification avec le type d'incident et l'adresse au responder assigné
- [x] Feature: Boutons "Accepter / En route / Sur place" pour les responders — Ajouté endpoint PUT /alerts/:id/respond, ajouté responderStatuses à l'interface Alert, boutons progressifs dans l'app (Assigné → Accepter → En route → Sur place), badges de statut colorés, notification dispatch quand un responder change de statut. 10 tests passent.
- [x] Feature: Timer d'acceptation 5 minutes — Si un responder ne répond pas dans les 5 minutes après assignation, notifier le dispatcher pour réassigner
- [x] Feature: Historique de statut — Enregistrer l'heure de chaque changement de statut (assigné, accepté, en route, sur place) pour les rapports
- [x] Feature: Afficher le statut des responders en temps réel sur la carte — Icônes dynamiques : ✅ Accepté (vert), 🚗 En route (bleu), 📍 Sur place (rouge), 🔔 Assigné (orange), 👮 Disponible/En service/Hors service. Appliqué sur carte Leaflet dispatch + carte web mobile. Labels avec nom + point de statut coloré.
- [x] Feature: Estimation du temps d'arrivée (ETA) basée sur la distance Haversine — Calcul distance + ETA à 40 km/h en milieu urbain. Affiché dans popups carte dispatch (pour chaque incident assigné), dans le détail d'incident (pour chaque responder), et sur la carte mobile. Format: distance (m/km) + ETA (min/h).
