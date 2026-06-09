/**
 * 数字输入组件
 */
import type { NumberInputProps } from "../../types/index";

import React, { useEffect, useState } from "react";
import { Input } from "@heroui/input";

/**
 * 数字类型配置项的输入组件
 */
const NumberInput: React.FC<NumberInputProps> = ({ label, labelNode, path, value, description, min, max, onChange, error }) => {
    const [inputValue, setInputValue] = useState(value === undefined ? "" : value.toString());

    useEffect(() => {
        setInputValue(value === undefined ? "" : value.toString());
    }, [value]);

    const handleChange = (nextValue: string) => {
        setInputValue(nextValue);

        if (nextValue === "") {
            // 清空输入框时同步清空 config 中的值，保持「所见即所存」。
            // 置为 undefined 会触发后端必填/类型校验报错并禁用保存，
            // 避免界面显示为空却静默保存旧值。
            onChange(path, undefined);

            return;
        }

        const parsed = Number.parseFloat(nextValue);

        if (!Number.isFinite(parsed)) {
            return;
        }

        onChange(path, parsed);
    };

    return (
        <div className="flex items-center min-h-8">
            <label className="text-sm font-medium w-40 shrink-0">{labelNode || label}</label>
            <Input
                classNames={{
                    inputWrapper: "h-8 min-h-8",
                    input: "text-xs",
                    description: "text-xs",
                    errorMessage: "text-xs"
                }}
                description={description}
                errorMessage={error}
                isInvalid={!!error}
                max={max}
                min={min}
                size="sm"
                type="number"
                value={inputValue}
                onValueChange={handleChange}
            />
        </div>
    );
};

export default NumberInput;
