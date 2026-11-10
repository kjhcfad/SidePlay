declare global { interface Window { YT: any; onYouTubeIframeAPIReady: () => void } }

let apiPromise: Promise<any> | null = null
export function loadYouTubeApi(): Promise<any> {
  if (window.YT?.Player) return Promise.resolve(window.YT)
  if (!apiPromise) {
    apiPromise = new Promise((resolve) => {
      const previous = window.onYouTubeIframeAPIReady
      window.onYouTubeIframeAPIReady = () => { previous?.(); resolve(window.YT) }
      if (!document.querySelector('script[data-youtube-api]')) {
        const script = document.createElement('script')
        script.src = 'https://www.youtube.com/iframe_api'
        script.dataset.youtubeApi = 'true'
        document.head.appendChild(script)
      }
    })
  }
  return apiPromise
}
