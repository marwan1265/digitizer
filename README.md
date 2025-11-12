Avatar Face Tracking (Three.js + MediaPipe)

Overview
- Loads `avatar.glb` with Three.js and animates the head using MediaPipe FaceMesh landmarks.
- Works as a static site (no build step). Ready for GitHub Pages.
- Mobile friendly with Start button (required user gesture for camera access on iOS/Safari).

Local Usage
1. Serve the folder over HTTP (browsers block camera on file://). Examples:
   - Python: `python3 -m http.server -b 0.0.0.0 8080`
   - Node `http-server` (if installed): `npx http-server -p 8080`
2. Open `http://localhost:8080/` and click "Start Camera".

Deploy to GitHub Pages
1. Commit these files to a repository. Ensure `index.html` is at the repo root.
2. Push to GitHub.
3. In your repo: Settings → Pages → Build and deployment → Source: "Deploy from a branch".
4. Select branch (e.g., `main`) and folder `/ (root)`. Save.
5. Wait for Pages to build, then open the provided URL.

Notes and Tips
- If the head doesn’t move: ensure camera permission is granted and there’s enough light.
- The Mirror toggle flips yaw/roll to match selfie view.
- Sensitivity adjusts the magnitude of head rotations.
- The code tries to find a `head` bone; if not found, it rotates the whole avatar.
- Performance: FaceMesh options are tuned for mobile. Reduce input resolution in `startCamera()` for older devices.

Customization
- Replace `avatar.glb` with your own model (keep the filename or update `main.js`).
- To drive blendshapes (lip sync, expressions), consider upgrading to MediaPipe Tasks FaceLandmarker with blendshape outputs and map names to your GLB morph targets.

Files
- `index.html` — App shell, UI, and script includes.
- `styles.css` — Mobile-friendly layout and controls.
- `main.js` — Three.js scene, avatar loading, MediaPipe integration, and head pose mapping.
- `avatar.glb` — Your 3D character.

