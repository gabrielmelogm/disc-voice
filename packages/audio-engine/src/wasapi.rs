use crate::backend::{Backend, BackendDevice, Direction, ErrorSink, InputSink, OutputSource};
use cpal::{
    platform::{WasapiDevice as Device, WasapiHost as Host, WasapiStream as Stream},
    traits::{DeviceTrait, HostTrait, StreamTrait},
    FromSample, Sample, SampleFormat, SizedSample, StreamConfig,
};

/// Windows backend over CPAL's WASAPI host.
pub struct WasapiBackend {
    host: Host,
}

impl WasapiBackend {
    pub fn new() -> Result<Self, String> {
        Ok(Self {
            host: Host::new().map_err(|error| error.to_string())?,
        })
    }
}

impl Backend for WasapiBackend {
    // WASAPI equality compares endpoint IDs, not names or list indexes.
    type Device = Device;
    type Stream = Stream;

    fn devices(&mut self, direction: Direction) -> Result<Vec<BackendDevice<Device>>, String> {
        let (devices, default): (Vec<Device>, _) = match direction {
            Direction::Input => (
                self.host
                    .input_devices()
                    .map_err(|error| error.to_string())?
                    .collect(),
                self.host.default_input_device(),
            ),
            Direction::Output => (
                self.host
                    .output_devices()
                    .map_err(|error| error.to_string())?
                    .collect(),
                self.host.default_output_device(),
            ),
        };
        Ok(devices
            .into_iter()
            .map(|device| BackendDevice {
                name: device
                    .name()
                    .unwrap_or_else(|_| "Dispositivo de áudio".into()),
                is_default: default.as_ref() == Some(&device),
                device,
            })
            .collect())
    }

    fn open_input(
        &mut self,
        device: &Device,
        sink: impl FnOnce(u32) -> InputSink,
        errors: ErrorSink,
    ) -> Result<Stream, String> {
        let supported = device
            .default_input_config()
            .map_err(|error| error.to_string())?;
        let config = supported.config();
        let sink = sink(config.sample_rate.0);
        let stream = match supported.sample_format() {
            SampleFormat::F32 => input_stream::<f32>(device, &config, sink, errors),
            SampleFormat::I16 => input_stream::<i16>(device, &config, sink, errors),
            SampleFormat::U8 => input_stream::<u8>(device, &config, sink, errors),
            SampleFormat::I32 => input_stream::<i32>(device, &config, sink, errors),
            SampleFormat::I64 => input_stream::<i64>(device, &config, sink, errors),
            format => Err(format!("Formato de entrada não suportado: {format:?}")),
        }?;
        stream.play().map_err(|error| error.to_string())?;
        Ok(stream)
    }

    fn open_output(
        &mut self,
        device: &Device,
        source: impl FnOnce(u32) -> Result<OutputSource, String>,
        errors: ErrorSink,
    ) -> Result<Stream, String> {
        let supported = device
            .default_output_config()
            .map_err(|error| error.to_string())?;
        let config = supported.config();
        let source = source(config.sample_rate.0)?;
        let stream = match supported.sample_format() {
            SampleFormat::F32 => output_stream::<f32>(device, &config, source, errors),
            SampleFormat::I16 => output_stream::<i16>(device, &config, source, errors),
            SampleFormat::U8 => output_stream::<u8>(device, &config, source, errors),
            SampleFormat::I32 => output_stream::<i32>(device, &config, source, errors),
            SampleFormat::I64 => output_stream::<i64>(device, &config, source, errors),
            format => Err(format!("Formato de saída não suportado: {format:?}")),
        }?;
        stream.play().map_err(|error| error.to_string())?;
        Ok(stream)
    }
}

fn input_stream<T>(
    device: &Device,
    config: &StreamConfig,
    sink: InputSink,
    errors: ErrorSink,
) -> Result<Stream, String>
where
    T: SizedSample,
    f32: FromSample<T>,
{
    let channels = config.channels as usize;
    device
        .build_input_stream(
            config,
            move |samples: &[T], _| {
                sink.capture(
                    samples
                        .chunks_exact(channels)
                        .map(|frame| frame.iter().map(|&sample| f32::from_sample(sample))),
                );
            },
            move |error| errors.report(error),
            None,
        )
        .map_err(|error| error.to_string())
}

fn output_stream<T>(
    device: &Device,
    config: &StreamConfig,
    mut source: OutputSource,
    errors: ErrorSink,
) -> Result<Stream, String>
where
    T: SizedSample + FromSample<f32>,
{
    let channels = config.channels as usize;
    device
        .build_output_stream(
            config,
            move |samples: &mut [T], _| {
                for frame in samples.chunks_mut(channels) {
                    frame.fill(T::from_sample(source.next_frame()));
                }
                source.end_buffer();
            },
            move |error| errors.report(error),
            None,
        )
        .map_err(|error| error.to_string())
}
