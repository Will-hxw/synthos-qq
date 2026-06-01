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
    const [inputValue, setInputValue] = useState(value.toString());

    useEffect(() => {
        setInputValue(value.toString());
    }, [value]);

    const handleChange = (nextValue: string) => {
        setInputValue(nextValue);

        if (nextValue === "") {
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
