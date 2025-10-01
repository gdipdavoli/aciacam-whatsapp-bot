# ACIACAM Project – Repo Bootstrap

Este paquete incluye archivos base para:
- CI en **GitHub Actions** y **GitLab CI**
- Versionado semántico con **standard-version**
- Templates de Pull/Merge Requests
- Convenciones de commits (Conventional Commits)

## Pasos rápidos
1. Copiá estos archivos a la raíz de tu proyecto.
2. `npm i -D standard-version`
3. Ajustá los nombres del proyecto en `package.json` si corresponde.
4. Hacé tu primer commit y empujá a GitHub/GitLab.
5. Para crear un release:  
   `npm run release -- --release-as minor && git push origin main --follow-tags && git push gitlab main --follow-tags`