//! Live speech-to-text while a voice message records, so the words show in the message box as
//! you speak. WebView2 has no working Web Speech recognition, so this uses Windows' own
//! recogniser (the one behind Win+H), which listens to the default microphone alongside the
//! recording. The text is only shown; the voice message is what's sent.

use serde::Serialize;
use tauri::AppHandle;

/// Emitted with what's been heard so far in a session.
pub const HEARD: &str = "dictation-heard";

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct Heard {
    session: u32,
    text: String,
}

#[cfg(windows)]
mod imp {
    use std::sync::atomic::{AtomicU32, Ordering};
    use std::sync::{Arc, Mutex};
    use std::time::Duration;

    use tauri::{AppHandle, Emitter};
    use windows::Foundation::{TimeSpan, TypedEventHandler};
    use windows::Media::SpeechRecognition::{
        SpeechContinuousRecognitionSession, SpeechContinuousRecognitionResultGeneratedEventArgs, SpeechRecognitionHypothesisGeneratedEventArgs,
        SpeechRecognitionResultStatus, SpeechRecognizer,
    };

    use super::{Heard, HEARD};

    /// The recogniser that's listening, if any.
    static ACTIVE: Mutex<Option<SpeechRecognizer>> = Mutex::new(None);
    /// The session that should be listening (0: none), so a stop that lands while a start is
    /// still warming up isn't lost.
    static WANTED: AtomicU32 = AtomicU32::new(0);

    /// Windows' "speech privacy policy wasn't accepted": online speech recognition is off.
    const PRIVACY_OFF: i32 = 0x8004_5509_u32 as i32;

    fn span(d: Duration) -> TimeSpan {
        TimeSpan { Duration: (d.as_nanos() / 100) as i64 }
    }

    pub fn start(app: AppHandle, session: u32) -> Result<(), String> {
        stop();
        WANTED.store(session, Ordering::SeqCst);
        let fail = |e: windows::core::Error| {
            if e.code().0 == PRIVACY_OFF {
                "Turn on Online speech recognition in Windows Settings (Privacy & security > Speech) to see your words as you speak.".to_string()
            } else {
                format!("Speech recognition couldn't start. {}", e.message())
            }
        };
        let rec = SpeechRecognizer::new().map_err(fail)?;
        let compiled = rec.CompileConstraintsAsync().map_err(fail)?.join().map_err(fail)?;
        if compiled.Status().map_err(fail)? != SpeechRecognitionResultStatus::Success {
            return Err("Speech recognition isn't available for your Windows display language.".into());
        }
        // Pauses in speech shouldn't end it; the recording decides when it's over.
        let timeouts = rec.Timeouts().map_err(fail)?;
        let _ = timeouts.SetInitialSilenceTimeout(span(Duration::from_secs(3600)));
        let _ = timeouts.SetBabbleTimeout(span(Duration::from_secs(3600)));
        let live = rec.ContinuousRecognitionSession().map_err(fail)?;
        let _ = live.SetAutoStopSilenceTimeout(span(Duration::from_secs(3600)));

        // Finished phrases, and the one still being spoken.
        let said = Arc::new(Mutex::new((String::new(), String::new())));
        let emit = {
            let said = said.clone();
            move |app: &AppHandle| {
                let (done, partial) = &*said.lock().unwrap();
                let text = [done.as_str(), partial.as_str()].iter().filter(|s| !s.is_empty()).copied().collect::<Vec<_>>().join(" ");
                let _ = app.emit(HEARD, Heard { session, text });
            }
        };

        {
            let (said, app, emit) = (said.clone(), app.clone(), emit.clone());
            rec.HypothesisGenerated(&TypedEventHandler::<SpeechRecognizer, SpeechRecognitionHypothesisGeneratedEventArgs>::new(move |_, args| {
                if let Some(args) = args.as_ref() {
                    said.lock().unwrap().1 = args.Hypothesis()?.Text()?.to_string();
                    emit(&app);
                }
                Ok(())
            }))
            .map_err(fail)?;
        }
        {
            let (said, app, emit) = (said.clone(), app.clone(), emit.clone());
            live.ResultGenerated(&TypedEventHandler::<SpeechContinuousRecognitionSession, SpeechContinuousRecognitionResultGeneratedEventArgs>::new(move |_, args| {
                if let Some(args) = args.as_ref() {
                    let text = args.Result()?.Text()?.to_string();
                    {
                        let mut s = said.lock().unwrap();
                        if !text.is_empty() {
                            if !s.0.is_empty() {
                                s.0.push(' ');
                            }
                            s.0.push_str(&text);
                        }
                        s.1.clear();
                    }
                    emit(&app);
                }
                Ok(())
            }))
            .map_err(fail)?;
        }

        live.StartAsync().map_err(fail)?.join().map_err(fail)?;
        *ACTIVE.lock().unwrap() = Some(rec);
        if WANTED.load(Ordering::SeqCst) != session {
            close();
        }
        Ok(())
    }

    pub fn stop() {
        WANTED.store(0, Ordering::SeqCst);
        close();
    }

    fn close() {
        let Some(rec) = ACTIVE.lock().unwrap().take() else { return };
        if let Ok(live) = rec.ContinuousRecognitionSession() {
            if let Ok(op) = live.CancelAsync() {
                let _ = op.join();
            }
        }
        let _ = rec.Close();
    }
}

#[cfg(not(windows))]
mod imp {
    use tauri::AppHandle;

    pub fn start(_app: AppHandle, _session: u32) -> Result<(), String> {
        Err("Speech recognition is only available on Windows.".into())
    }

    pub fn stop() {}
}

/// Starts listening; what's heard arrives as `dictation-heard` events tagged with `session`.
#[tauri::command]
pub async fn dictation_start(app: AppHandle, session: u32) -> Result<(), String> {
    tauri::async_runtime::spawn_blocking(move || imp::start(app, session)).await.map_err(|e| e.to_string())?
}

#[tauri::command]
pub async fn dictation_stop() {
    let _ = tauri::async_runtime::spawn_blocking(imp::stop).await;
}
